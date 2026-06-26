/**
 * PROJECT TITAN — Tokenize use-case (APPLICATION layer). Thin orchestration over
 * the tokenization gateway; the controller maps the outcome to HTTP.
 */
import { TokenizeUseCase, TokenizationGateway, EncryptedCardPayload, TokenizeOutcome } from './tokenization';

export class TokenizeService implements TokenizeUseCase {
  constructor(private readonly gateway: TokenizationGateway) {}

  async tokenize(payload: EncryptedCardPayload, correlationToken: string): Promise<TokenizeOutcome> {
    return this.gateway.tokenize(payload, correlationToken);
  }
}
