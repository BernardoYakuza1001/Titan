/**
 * PROJECT TITAN — Payment Router (Phase 4)
 *
 * Resolves a transaction's profile `processorRoute` to a concrete acquirer route
 * + adapter, choosing among healthy candidates by success-rate then cost
 * (least-cost routing). Health/cost come from a metrics store; here they are
 * injected so routing policy is testable and tunable without redeploys.
 */
import { MerchantRoute, PaymentGatewayAdapter } from './gateway/payment-gateway.port';

export interface RouteCandidate {
  route: MerchantRoute;
  healthy: boolean;
  successRate: number;   // rolling, 0..1
  costBps: number;       // basis points; lower is cheaper
}

export interface RouteStore {
  candidatesFor(routeId: string, currency: string): Promise<RouteCandidate[]>;
}

export class PaymentRouter {
  constructor(
    private readonly store: RouteStore,
    private readonly adapters: Map<string, PaymentGatewayAdapter>, // processor -> adapter
  ) {}

  async pick(routeId: string, currency: string): Promise<{ route: MerchantRoute; adapter: PaymentGatewayAdapter }> {
    const candidates = (await this.store.candidatesFor(routeId, currency)).filter((c) => c.healthy);
    if (candidates.length === 0) throw new Error(`no healthy acquirer for route ${routeId}/${currency}`);

    // success-rate first (money must land), then cheapest among the top tier
    candidates.sort((a, b) => (b.successRate - a.successRate) || (a.costBps - b.costBps));
    const chosen = candidates[0];

    const adapter = this.adapters.get(chosen.route.processor);
    if (!adapter) throw new Error(`no adapter for processor ${chosen.route.processor}`);
    return { route: chosen.route, adapter };
  }
}
