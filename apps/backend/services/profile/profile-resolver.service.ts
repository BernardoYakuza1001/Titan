/**
 * PROJECT TITAN — Profile Resolver (Phase 3)
 *
 * Resolves the effective profile for a device by merging, in precedence order:
 *   defaults < family < profile < device-override < (risk clamp applied later)
 * then re-signs the result and stamps an ETag + TTL. The risk engine may TIGHTEN
 * caps at runtime, but never loosen beyond what the resolver produced.
 */
import { Injectable } from '@nestjs/common';
import {
  TerminalProfile, ResolvedProfile, ProfileDimensions, DEGRADED_PROFILE_DIMENSIONS,
} from '@titan/profile-schema';
import { canonicalize, signDimensions } from '@titan/profile-schema';
import { createHash } from 'crypto';

export interface ProfileRepo {
  familyDefaults(family: string): Promise<Partial<ProfileDimensions>>;
  profileById(id: string): Promise<TerminalProfile | null>;
  deviceOverride(deviceId: string): Promise<Partial<ProfileDimensions>>;
  assignedProfileId(deviceId: string): Promise<string | null>;
  compliancePackOverrides(pack: string): Promise<Partial<ProfileDimensions>>;
}

@Injectable()
export class ProfileResolver {
  constructor(
    private readonly repo: ProfileRepo,
    private readonly signingKey: Uint8Array,   // from HSM/KMS in prod
    private readonly now: () => number,        // injected clock (ms)
    private readonly ttlSeconds = 900,
  ) {}

  async resolve(deviceId: string): Promise<ResolvedProfile> {
    const profileId = await this.repo.assignedProfileId(deviceId);
    const profile = profileId ? await this.repo.profileById(profileId) : null;
    if (!profile) return this.degraded(deviceId);

    const defaults = await this.repo.familyDefaults(profile.family);
    const packOverrides = await this.repo.compliancePackOverrides(profile.dimensions.compliancePack);
    const deviceOverride = await this.repo.deviceOverride(deviceId);

    // precedence: defaults < family profile < jurisdiction pack < device override
    const merged: ProfileDimensions = {
      ...DEGRADED_PROFILE_DIMENSIONS, // safe baseline for any missing field
      ...defaults,
      ...profile.dimensions,
      ...packOverrides,
      ...deviceOverride,
    };

    // jurisdiction pack can only TIGHTEN caps (compliance never loosens limits)
    merged.txCaps = {
      currency: merged.txCaps.currency,
      perTxn: Math.min(profile.dimensions.txCaps.perTxn, merged.txCaps.perTxn),
      daily: Math.min(profile.dimensions.txCaps.daily, merged.txCaps.daily),
    };

    return this.sign({ ...profile, dimensions: merged }, deviceId);
  }

  private degraded(deviceId: string): ResolvedProfile {
    return this.sign(
      {
        id: '00000000-0000-0000-0000-000000000000',
        label: 'DEGRADED',
        family: 'system',
        version: 1,
        dimensions: DEGRADED_PROFILE_DIMENSIONS,
        signature: '',
      },
      deviceId,
    );
  }

  private sign(profile: TerminalProfile, deviceId: string): ResolvedProfile {
    const signature = signDimensions(profile.dimensions, this.signingKey);
    const etag = createHash('sha256')
      .update(canonicalize(profile.dimensions) + deviceId)
      .digest('hex')
      .slice(0, 16);
    const expiresAt = new Date(this.now() + this.ttlSeconds * 1000).toISOString();
    return { ...profile, signature, resolvedFor: deviceId, etag, expiresAt };
  }
}
