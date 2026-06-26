/**
 * PROJECT TITAN — Payment Gateway Adapter Layer (Phase 4)
 *
 * ONE normalized interface over every acquirer/processor. Adapters (Adyen,
 * Checkout.com, Stripe Terminal, local acquirers) translate to/from this shape
 * so the Auth Engine, router, and saga never learn a processor's quirks.
 *
 * `idempotencyKey` is mandatory on every money-moving call: a replayed call to
 * the same processor returns the original result instead of double-charging.
 */

export interface MerchantRoute {
  routeId: string;        // matches profile.dimensions.processorRoute
  processor: 'adyen' | 'checkout' | 'stripe' | string;
  merchantAccount: string;
  mid: string;
}

export interface AuthorizeRequest {
  idempotencyKey: string;
  route: MerchantRoute;
  amountMinor: number;    // integer minor units (e.g. cents) — never floats for money
  currency: string;
  cardToken: string;      // network token; raw PAN never reaches us
  reference: string;      // our transaction id
  preAuth: boolean;       // hold-only vs auth-and-capture intent
}

export interface GatewayResult {
  ok: boolean;
  authCode?: string;
  networkRef?: string;    // pspReference / acquirer ref for later void/capture
  reason?: string;        // declined reason code, normalized
  raw?: unknown;          // original processor payload (for audit/debug)
}

export interface VoidRequest {
  idempotencyKey: string;
  route: MerchantRoute;
  networkRef: string;
  reference: string;
}

/** Every processor adapter implements exactly this. */
export interface PaymentGatewayAdapter {
  readonly processor: string;
  authorize(req: AuthorizeRequest): Promise<GatewayResult>;
  void(req: VoidRequest): Promise<GatewayResult>;
  // capture/refund omitted from this slice; same shape, added with settlement
}

/** Minimal HTTP port so adapters are unit-testable without real network. */
export interface HttpClient {
  post(url: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; body: any }>;
}
