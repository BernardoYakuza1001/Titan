/**
 * PROJECT TITAN — mint a device session JWT (HS256) for testing.
 *
 * In production the Auth/Device service issues these after attestation; this
 * mirrors signDeviceToken() in security/device-auth.guard.ts. The token's `sub`
 * is the terminal id; the DeviceAuthGuard sets x-terminal-id from it.
 *
 *   node --env-file=.env scripts/mint-device-token.mjs [terminalId] [validDays]
 */
import { createHmac } from 'crypto';

const secret = process.env.DEVICE_JWT_SECRET;
if (!secret) { console.error('DEVICE_JWT_SECRET not set (use --env-file=.env)'); process.exit(2); }

const terminalId = process.argv[2] || 'TERM-1';
const days = Number(process.argv[3] || 365);

const b64 = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const exp = Math.floor(Date.now() / 1000) + days * 24 * 3600;
const body = b64(JSON.stringify({ sub: terminalId, exp }));
const data = `${header}.${body}`;
const sig = b64(createHmac('sha256', secret).update(data).digest());

console.log(`${data}.${sig}`);
console.error(`(terminalId=${terminalId}, expires in ${days} day(s))`);
