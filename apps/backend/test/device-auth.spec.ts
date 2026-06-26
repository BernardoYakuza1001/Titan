/**
 * PROJECT TITAN — device-auth guard + JWT device-token verifier.
 */
import { ExecutionContext } from '@nestjs/common';
import {
  DeviceAuthGuard, JwtDeviceVerifier, signDeviceToken,
} from '../services/viva/security/device-auth.guard';

const SECRET = 'test-secret';
const verifier = (nowSec = 1000) => new JwtDeviceVerifier(SECRET, () => nowSec);

function ctxWith(headers: Record<string, unknown>): ExecutionContext {
  const req = { headers } as { headers: Record<string, unknown>; terminalId?: string };
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

describe('JwtDeviceVerifier', () => {
  it('verifies a freshly signed token -> terminalId', () => {
    const tok = signDeviceToken({ sub: 'TERM-7', exp: 2000 }, SECRET);
    expect(verifier(1000).verify(tok)).toEqual({ terminalId: 'TERM-7' });
  });
  it('rejects a tampered token', () => {
    const tok = signDeviceToken({ sub: 'TERM-7', exp: 2000 }, SECRET);
    const bad = tok.slice(0, -2) + (tok.endsWith('a') ? 'b' : 'a');
    expect(() => verifier().verify(bad)).toThrow();
  });
  it('rejects an expired token', () => {
    const tok = signDeviceToken({ sub: 'TERM-7', exp: 500 }, SECRET);
    expect(() => verifier(1000).verify(tok)).toThrow(/expired/);
  });
  it('rejects a token signed with the wrong secret', () => {
    const tok = signDeviceToken({ sub: 'X', exp: 2000 }, 'other-secret');
    expect(() => verifier(1000).verify(tok)).toThrow();
  });
});

describe('DeviceAuthGuard', () => {
  const guard = new DeviceAuthGuard(verifier(1000));

  it('admits a valid Bearer credential and sets the AUTHORITATIVE x-terminal-id (overwriting a spoof)', () => {
    const tok = signDeviceToken({ sub: 'TERM-9', exp: 2000 }, SECRET);
    const ctx = ctxWith({ authorization: `Bearer ${tok}`, 'x-terminal-id': 'SPOOFED' });
    expect(guard.canActivate(ctx)).toBe(true);
    const req = ctx.switchToHttp().getRequest() as { headers: Record<string, unknown>; terminalId?: string };
    expect(req.headers['x-terminal-id']).toBe('TERM-9');
    expect(req.terminalId).toBe('TERM-9');
  });
  it('rejects a missing credential', () => {
    expect(() => guard.canActivate(ctxWith({}))).toThrow();
  });
  it('rejects an invalid credential', () => {
    expect(() => guard.canActivate(ctxWith({ authorization: 'Bearer not.a.jwt' }))).toThrow();
  });
});
