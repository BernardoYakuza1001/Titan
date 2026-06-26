/**
 * PROJECT TITAN — Postgres profile repository (Deliverable 5)
 *
 * Backs the ProfileResolver's merge sources:
 *   * assignedProfileId(device)      -> profile_assignments / devices
 *   * profileById(id)                -> profiles (id, label, family, version,
 *                                       dimensions jsonb, signature)
 *   * familyDefaults(family)         -> profile_overrides (scope='family')
 *   * deviceOverride(device)         -> profile_overrides (scope='device')
 *   * compliancePackOverrides(pack)  -> profile_overrides (scope='pack')
 *
 * The override sources return PARTIAL dimensions (jsonb), which the resolver
 * merges over the DEGRADED baseline. A missing override row => `{}` (fail-safe:
 * the resolver then relies on the profile's own dimensions + degraded floor).
 */
import type { Db } from './db';
import type {
  ProfileDimensions,
  TerminalProfile,
} from '@titan/profile-schema';
import type { ProfileRepo } from '../../services/profile/profile-resolver.service';

interface ProfileRow {
  id: string;
  label: string | null;
  family: string | null;
  version: number;
  dimensions: ProfileDimensions | string;
  signature: Buffer | string | null;
}

export class PgProfileRepo implements ProfileRepo {
  constructor(private readonly db: Db) {}

  /** Most recent assignment for the device (latest effective_at wins). */
  async assignedProfileId(deviceId: string): Promise<string | null> {
    const res = await this.db.query(
      `SELECT profile_id
         FROM profile_assignments
        WHERE device_id = $1
        ORDER BY effective_at DESC
        LIMIT 1`,
      [deviceId],
    );
    return res.rows.length ? (res.rows[0].profile_id as string) : null;
  }

  async profileById(id: string): Promise<TerminalProfile | null> {
    const res = await this.db.query(
      `SELECT id, label, family, version, dimensions, signature
         FROM profiles
        WHERE id = $1`,
      [id],
    );
    if (!res.rows.length) return null;
    const row = res.rows[0] as ProfileRow;
    return {
      id: row.id,
      label: row.label ?? '',
      family: row.family ?? '',
      version: row.version,
      dimensions: parseDimensions(row.dimensions),
      signature: signatureToString(row.signature),
    };
  }

  async familyDefaults(family: string): Promise<Partial<ProfileDimensions>> {
    return this.override('family', family);
  }

  async deviceOverride(deviceId: string): Promise<Partial<ProfileDimensions>> {
    return this.override('device', deviceId);
  }

  async compliancePackOverrides(pack: string): Promise<Partial<ProfileDimensions>> {
    return this.override('pack', pack);
  }

  /** Read a partial-dimensions override row by (scope, key). */
  private async override(
    scope: 'family' | 'device' | 'pack',
    key: string,
  ): Promise<Partial<ProfileDimensions>> {
    const res = await this.db.query(
      `SELECT dimensions
         FROM profile_overrides
        WHERE scope = $1 AND scope_key = $2`,
      [scope, key],
    );
    if (!res.rows.length) return {};
    return parsePartial(res.rows[0].dimensions);
  }
}

function parseDimensions(v: ProfileDimensions | string): ProfileDimensions {
  return typeof v === 'string' ? (JSON.parse(v) as ProfileDimensions) : v;
}

function parsePartial(v: unknown): Partial<ProfileDimensions> {
  if (v == null) return {};
  return typeof v === 'string' ? (JSON.parse(v) as Partial<ProfileDimensions>) : (v as Partial<ProfileDimensions>);
}

/** signature column is bytea; normalize to the base64-ish string the type expects. */
function signatureToString(sig: Buffer | string | null): string {
  if (sig == null) return '';
  if (typeof sig === 'string') return sig;
  return Buffer.from(sig).toString('base64');
}
