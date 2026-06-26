/**
 * PROJECT TITAN — CreateCheckoutOrder use-case (APPLICATION layer). Thin
 * orchestration over the order gateway; the controller maps the outcome to HTTP.
 */
import { CreateCheckoutOrderUseCase, CheckoutOrderGateway, CheckoutOrderRequest, CreateOrderOutcome } from './checkout';

export class CreateCheckoutOrderService implements CreateCheckoutOrderUseCase {
  constructor(private readonly gateway: CheckoutOrderGateway) {}

  async create(req: CheckoutOrderRequest): Promise<CreateOrderOutcome> {
    return this.gateway.createOrder(req);
  }
}
