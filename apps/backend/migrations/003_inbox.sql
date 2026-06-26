-- PROJECT TITAN — Idempotent inbox dedup table (Deliverable 5/8)
-- Backs libs/messaging/inbox.consumer.ts. The relay is at-least-once, so a
-- consumer will occasionally see the same event twice; this table turns that
-- into an exactly-once EFFECT. The PRIMARY KEY is the dedup guard: a concurrent
-- double-delivery makes the second INSERT collide, so only one worker applies it.
--
-- Portability: message_id is supplied by the application (the ledger event hash,
-- falling back to the outbox row id), so no DB-side default is required for pg-mem.

CREATE TABLE IF NOT EXISTS inbox_processed (
  message_id   text        PRIMARY KEY,            -- ledger event hash (or outbox id)
  topic        text        NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);
