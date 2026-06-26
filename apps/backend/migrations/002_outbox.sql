-- PROJECT TITAN — Transactional outbox (Deliverable 5/8)
-- A domain write appends a ledger_events row AND inserts an outbox row in the
-- SAME DB transaction; a separate relay (libs/messaging, owned by another agent)
-- later publishes unpublished rows to Kafka at-least-once and stamps
-- published_at. Columns match the OutboxRecord contract in
-- libs/messaging/messaging.ports.ts.
--
-- Portability: id is supplied by the application (the OutboxStore assigns a uuid
-- before insert), so no DB-side uuid default is required for pg-mem.

CREATE TABLE IF NOT EXISTS outbox (
  id            uuid PRIMARY KEY,
  seq           bigserial NOT NULL,            -- monotonic insertion order (FIFO tiebreak)
  aggregate_id  uuid NOT NULL,                 -- transaction id this event belongs to
  type          text NOT NULL,                 -- domain event type (e.g. AUTHORIZED)
  topic         text NOT NULL,                 -- destination Kafka topic
  key           text NOT NULL,                 -- partition key (usually aggregate_id)
  payload       jsonb NOT NULL,                -- event body
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,                   -- NULL while pending; set when relayed
  attempts      int NOT NULL DEFAULT 0         -- publish attempts (backoff / poison)
);

-- The relay scans for pending rows (published_at IS NULL) and drains them in
-- STRICT insertion order. `seq` is a monotonic bigserial assigned by the DB on
-- insert; it is the ONLY reliable FIFO tiebreak. created_at is an app-supplied
-- millisecond clock and id is a RANDOM uuid, so two same-millisecond events for
-- one aggregate must be ordered by seq, never by (created_at, id) — otherwise a
-- later event could overtake an earlier one on the same Kafka partition.
--
-- A composite index on (published_at, seq) lets the relay both filter unpublished
-- rows and order them deterministically without a full scan.
CREATE INDEX IF NOT EXISTS ix_outbox_published_seq
  ON outbox (published_at, seq);
