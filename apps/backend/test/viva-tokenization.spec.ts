/**
 * PROJECT TITAN — server-side tokenization gateway + controller.
 */
import { HttpException } from '@nestjs/common';
import { VivaTokenizationGateway } from '../services/viva/viva-tokenization.gateway';
import { TokenizeController } from '../services/viva/tokenize.controller';
import { HttpClient } from '../services/viva/viva.adapter';
import { AuthHeaderProvider } from '../services/viva/viva-auth';
import { TokenizeUseCase, EncryptedCardPayload, TokenizeOutcome } from '../services/viva/tokenization';

const payload: EncryptedCardPayload = {
  encryptedPayload: 'BASE64CIPHER',
  ksn: 'FFFF9876543210E00001',
  maskedPan: '411111****1111',
  cardBrand: 'VISA',
  expiryMonth: 12,
  expiryYear: 2030,
};
const auth: AuthHeaderProvider = { async authHeader() { return 'Basic xyz'; } };
const cfg = { baseUrl: 'https://demo-api.viva.com', tokenizePath: '/acquiring/v1/cards/tokens' };

function http(res: any, opts: { throws?: boolean } = {}) {
  const calls: any[] = [];
  const h: HttpClient = {
    async post(u, b, hd) { calls.push({ u, b, hd }); if (opts.throws) throw new Error('net'); return res; },
  };
  return { h, calls };
}

describe('VivaTokenizationGateway', () => {
  it('maps a token response to ok + chargeToken + expiry; sends ciphertext, never a PAN', async () => {
    const { h, calls } = http({ status: 200, body: { token: 'ct_1', expiresIn: 600 } });
    const out = await new VivaTokenizationGateway(h, auth, cfg, () => 1_000).tokenize(payload, 'corr-1');
    expect(out.ok).toBe(true);
    expect(out.chargeToken).toBe('ct_1');
    expect(out.expiresAtMs).toBe(1_000 + 600_000);
    expect(out.maskedPan).toBe('411111****1111');
    expect(calls[0].b.encryptedData).toBe('BASE64CIPHER');
    expect(calls[0].b.ksn).toBe('FFFF9876543210E00001');
    expect(calls[0].hd['Idempotency-Key']).toBe('corr-1');
    expect(JSON.stringify(calls[0])).not.toContain('411111111111');
  });
  it('401 -> CONFIGURATION_ERROR', async () => {
    const { h } = http({ status: 401, body: {} });
    expect((await new VivaTokenizationGateway(h, auth, cfg).tokenize(payload, 'c')).error?.code).toBe('CONFIGURATION_ERROR');
  });
  it('5xx -> GATEWAY_ERROR', async () => {
    const { h } = http({ status: 500, body: {} });
    expect((await new VivaTokenizationGateway(h, auth, cfg).tokenize(payload, 'c')).error?.code).toBe('GATEWAY_ERROR');
  });
  it('thrown HTTP -> GATEWAY_TIMEOUT', async () => {
    const { h } = http({}, { throws: true });
    expect((await new VivaTokenizationGateway(h, auth, cfg).tokenize(payload, 'c')).error?.code).toBe('GATEWAY_TIMEOUT');
  });
  it('auth failure -> CONFIGURATION_ERROR (no HTTP call)', async () => {
    const { h, calls } = http({ status: 200, body: { token: 'x' } });
    const badAuth: AuthHeaderProvider = { async authHeader() { throw new Error('no creds'); } };
    const out = await new VivaTokenizationGateway(h, badAuth, cfg).tokenize(payload, 'c');
    expect(out.error?.code).toBe('CONFIGURATION_ERROR');
    expect(calls).toHaveLength(0);
  });
  it('declines an invalid-card body', async () => {
    const { h } = http({ status: 400, body: { ErrorText: 'Invalid card number' } });
    expect((await new VivaTokenizationGateway(h, auth, cfg).tokenize(payload, 'c')).error?.code).toBe('INVALID_CARD');
  });
});

describe('TokenizeController', () => {
  const useCase = (o: TokenizeOutcome): TokenizeUseCase => ({ async tokenize() { return o; } });
  const dto = { ...payload, correlationToken: 'corr-1' } as any;

  it('returns a PaymentToken-shaped response on success', async () => {
    const ctrl = new TokenizeController(useCase({ ok: true, chargeToken: 'ct_9', expiresAtMs: 5000 }));
    const res = await ctrl.createToken('TERM-1', dto);
    expect(res.token).toBe('ct_9');
    expect(res.tokenProvider).toBe('viva');
    expect(res.maskedPan).toBe('411111****1111');
  });
  it('rejects when terminal identity is missing', async () => {
    const ctrl = new TokenizeController(useCase({ ok: true, chargeToken: 'x' }));
    await expect(ctrl.createToken(undefined, dto)).rejects.toThrow();
  });
  it('maps a config/gateway error to 502', async () => {
    const ctrl = new TokenizeController(useCase({ ok: false, error: { code: 'CONFIGURATION_ERROR', message: 'x', retriable: true } }));
    let err: unknown;
    try { await ctrl.createToken('TERM-1', dto); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(502);
  });
  it('maps a card decline to 402', async () => {
    const ctrl = new TokenizeController(useCase({ ok: false, error: { code: 'INVALID_CARD', message: 'x', retriable: false } }));
    let err: unknown;
    try { await ctrl.createToken('TERM-1', dto); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(402);
  });
});
