/**
 * PROJECT TITAN — fetch-based HttpClient for the Viva charge calls (Node 18+).
 * A network error / timeout throws, which the adapter maps to GATEWAY_TIMEOUT.
 */
import { HttpClient } from './viva.adapter';
import { HttpGetClient } from './viva-verify';
import { VivaHttpResponse } from './error-map';

export class FetchHttpClient implements HttpClient, HttpGetClient {
  constructor(private readonly timeoutMs = 15_000) {}

  async post(url: string, body: unknown, headers: Record<string, string>): Promise<VivaHttpResponse> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...headers },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const respBody = await res.json().catch(() => ({}));
      return { status: res.status, body: respBody };
    } finally {
      clearTimeout(t);
    }
  }

  async get(url: string, headers: Record<string, string>): Promise<VivaHttpResponse> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { ...headers },
        signal: ctrl.signal,
      });
      const respBody = await res.json().catch(() => ({}));
      return { status: res.status, body: respBody };
    } finally {
      clearTimeout(t);
    }
  }
}
