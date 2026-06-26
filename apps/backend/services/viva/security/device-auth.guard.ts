/**
 * PROJECT TITAN — Device authentication guard (Phase 2 device identity -> Phase 1 acquiring).
 *
 * Every terminal call carries a short-lived device session credential (a signed
 * JWT minted by the Auth/Device service AFTER attestation at enrollment). This
 * guard verifies it and sets the AUTHORITATIVE `x-terminal-id` from the token's
 * subject, OVERWRITING anything the client sent. That is what makes
 * `/api/v1/terminal/history` safe: a terminal can only ever act/read as itself —
 * the terminal id is never a spoofable request parameter.
 *
 * The JWT is HS256, verified with Node `crypto` (no external dependency). In a
 * multi-service deployment use asymmetric keys (the Auth service signs with a
 * private key; this verifies with the public key) — swap `JwtDeviceVerifier` for
 * an RS256 implementation behind the same `DeviceIdentityVerifier` port.
 */
import {
  CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { DEVICE_VERIFIER } from '../tokens';

export interface DeviceIdentity {
  terminalId: string;
}

/** Verifies a device session credential and returns its identity. */
export interface DeviceIdentityVerifier {
  verify(token: string): DeviceIdentity;
}

// ---- base64url helpers ----
function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Mint a device session token (used by the Auth/Device service at enrollment). */
export function signDeviceToken(payload: { sub: string; exp: number }, secret: string): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const data = `${header}.${body}`;
  const sig = b64url(createHmac('sha256', secret).update(data).digest());
  return `${data}.${sig}`;
}

export class JwtDeviceVerifier implements DeviceIdentityVerifier {
  constructor(
    private readonly secret: string,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  verify(token: string): DeviceIdentity {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('malformed token');
    const [h, b, s] = parts;

    const expected = b64url(createHmac('sha256', this.secret).update(`${h}.${b}`).digest());
    const got = Buffer.from(s);
    const exp = Buffer.from(expected);
    if (got.length !== exp.length || !timingSafeEqual(got, exp)) throw new Error('bad signature');

    const payload = JSON.parse(b64urlDecode(b).toString('utf8')) as { sub?: string; exp?: number };
    if (typeof payload.exp === 'number' && payload.exp < this.now()) throw new Error('token expired');
    if (!payload.sub) throw new Error('missing subject (terminal id)');
    return { terminalId: String(payload.sub) };
  }
}

@Injectable()
export class DeviceAuthGuard implements CanActivate {
  constructor(@Inject(DEVICE_VERIFIER) private readonly verifier: DeviceIdentityVerifier) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      terminalId?: string;
    }>();
    const raw = req.headers['authorization'] ?? req.headers['Authorization'];
    const auth = Array.isArray(raw) ? raw[0] : raw;
    if (!auth || !auth.startsWith('Bearer ')) {
      throw new UnauthorizedException('missing device credential');
    }
    let identity: DeviceIdentity;
    try {
      identity = this.verifier.verify(auth.slice('Bearer '.length).trim());
    } catch (e) {
      throw new UnauthorizedException(`invalid device credential: ${(e as Error).message}`);
    }
    // Authoritative identity — overwrite any client-supplied terminal id.
    req.terminalId = identity.terminalId;
    req.headers['x-terminal-id'] = identity.terminalId;
    return true;
  }
}
