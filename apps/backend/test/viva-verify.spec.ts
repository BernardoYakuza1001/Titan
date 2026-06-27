/**
 * PROJECT TITAN — VivaTransactionVerifier: webhook-token handshake + the
 * independent transaction lookup that confirms (or refutes) a webhook event.
 */
import { VivaTransactionVerifier, HttpGetClient } from '../services/viva/viva-verify';
import { BasicAuthProvider } from '../services/viva/viva-auth';

function getClient(res: any, opts: { throws?: boolean } = {}): { h: HttpGetClient; calls: any[] } {
  const calls: any[] = [];
  const h: HttpGetClient = {
    async get(u, hd) { calls.push({ u, hd }); if (opts.throws) throw new Error('net'); return res; },
  };
  return { h, calls };
}

const auth = new BasicAuthProvider('MID', 'KEY');
const cfg = { wwwBaseUrl: 'https://www.vivapayments.com' };
const BASIC = 'Basic ' + Buffer.from('MID:KEY').toString('base64');

describe('VivaTransactionVerifier.getWebhookToken', () => {
  it('returns the static token with no HTTP call when configured', async () => {
    const { h, calls } = getClient({ status: 200, body: {} });
    const v = new VivaTransactionVerifier(h, auth, { ...cfg, staticWebhookToken: 'STATIC' });
    expect(await v.getWebhookToken()).toBe('STATIC');
    expect(calls).toHaveLength(0);
  });

  it('fetches { Key } from Viva (Basic auth) when no static token', async () => {
    const { h, calls } = getClient({ status: 200, body: { Key: 'abc123' } });
    const v = new VivaTransactionVerifier(h, auth, cfg);
    expect(await v.getWebhookToken()).toBe('abc123');
    expect(calls[0].u).toBe('https://www.vivapayments.com/api/messages/config/token');
    expect(calls[0].hd.Authorization).toBe(BASIC);
  });

  it('throws when Viva returns no Key', async () => {
    const { h } = getClient({ status: 403, body: {} });
    await expect(new VivaTransactionVerifier(h, auth, cfg).getWebhookToken()).rejects.toThrow();
  });
});

describe('VivaTransactionVerifier.getTransaction', () => {
  it('maps a flat transaction body and hits the right URL', async () => {
    const { h, calls } = getClient({ status: 200, body: { StatusId: 'F', OrderCode: 12345, Amount: 1.0, CurrencyCode: '978' } });
    const t = await new VivaTransactionVerifier(h, auth, cfg).getTransaction('TXN-1');
    expect(t).toEqual({ transactionId: 'TXN-1', orderCode: '12345', statusId: 'F', amountMajor: 1.0, currencyCode: '978' });
    expect(calls[0].u).toBe('https://www.vivapayments.com/api/transactions/TXN-1');
    expect(calls[0].hd.Authorization).toBe(BASIC);
  });

  it('maps a { Transactions: [...] } envelope body', async () => {
    const { h } = getClient({ status: 200, body: { Transactions: [{ StatusId: 'F', OrderCode: 999, Amount: 5.5 }] } });
    const t = await new VivaTransactionVerifier(h, auth, cfg).getTransaction('TXN-2');
    expect(t?.orderCode).toBe('999');
    expect(t?.amountMajor).toBe(5.5);
  });

  it('returns null on non-2xx and on network throw', async () => {
    expect(await new VivaTransactionVerifier(getClient({ status: 404, body: {} }).h, auth, cfg).getTransaction('X')).toBeNull();
    expect(await new VivaTransactionVerifier(getClient({}, { throws: true }).h, auth, cfg).getTransaction('X')).toBeNull();
  });
});
