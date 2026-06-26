/**
 * PROJECT TITAN — Viva Wallet response -> domain error mapping.
 *
 * Translates HTTP transport codes AND Viva transaction/error indicators into the
 * provider-agnostic AcquiringError taxonomy, so the rest of the system never
 * branches on Viva specifics. The decline table is the single seam to extend with
 * the exact numeric ErrorCode / EventId values from your Viva sandbox. The
 * `transportError` + `classifyDeclineError` helpers are shared by both the charge
 * adapter and the tokenization gateway.
 */
import { ChargeOutcome, AcquiringError, AcquiringErrorCode } from './domain';

export interface VivaHttpResponse {
  status: number;
  body: any; // PascalCase in some Viva APIs, camelCase in others — read both.
}

/** Viva StatusId values that mean the charge succeeded (captured / authorized). */
const APPROVED_STATUS = new Set(['F', 'A']);

/** Decline classification by ErrorText/EventText substring (order = priority). */
const DECLINE_TEXT_RULES: Array<{ match: RegExp; code: AcquiringErrorCode; retriable: boolean }> = [
  { match: /insufficient|not enough funds|51\b/i, code: 'INSUFFICIENT_FUNDS', retriable: false },
  { match: /expired|54\b/i,                       code: 'EXPIRED_CARD',       retriable: false },
  { match: /invalid card|invalid pan|card number|14\b/i, code: 'INVALID_CARD', retriable: false },
  { match: /do not honou?r|05\b/i,                code: 'DO_NOT_HONOR',       retriable: false },
  { match: /fraud|security|pick ?up|43\b|07\b/i,  code: 'FRAUD_SUSPECTED',    retriable: false },
  { match: /duplicate/i,                          code: 'DUPLICATE_TRANSACTION', retriable: false },
  { match: /amount|13\b/i,                        code: 'INVALID_AMOUNT',     retriable: false },
];

function field(body: any, ...keys: string[]): any {
  for (const k of keys) {
    if (body && body[k] !== undefined && body[k] !== null) return body[k];
  }
  return undefined;
}

/** Transport-level (HTTP status) error, or null if the status is not itself an error. */
export function transportError(status: number): AcquiringError | null {
  if (status === 401 || status === 403) {
    return { code: 'CONFIGURATION_ERROR', message: 'acquirer auth/permission rejected', providerCode: String(status), retriable: false };
  }
  if (status === 408 || status === 504) {
    return { code: 'GATEWAY_TIMEOUT', message: 'acquirer timed out', providerCode: String(status), retriable: true };
  }
  if (status >= 500) {
    return { code: 'GATEWAY_ERROR', message: 'acquirer server error', providerCode: String(status), retriable: true };
  }
  return null;
}

/** Classify an application-level decline body into a domain error. */
export function classifyDeclineError(body: any): AcquiringError {
  const text = String(field(body, 'ErrorText', 'errorText', 'EventText', 'eventText', 'Message', 'message') ?? '');
  const providerCode = String(field(body, 'ErrorCode', 'errorCode', 'EventId', 'eventId') ?? 'UNKNOWN');
  for (const rule of DECLINE_TEXT_RULES) {
    if (rule.match.test(text) || rule.match.test(providerCode)) {
      return { code: rule.code, message: text || rule.code, providerCode, retriable: rule.retriable };
    }
  }
  return { code: 'CARD_DECLINED', message: text || 'card declined', providerCode, retriable: false };
}

/** Map a Viva charge response to a ChargeOutcome. Pure; deterministic. */
export function mapVivaResponse(res: VivaHttpResponse): ChargeOutcome {
  const { status, body } = res;

  const te = transportError(status);
  if (te) return { approved: false, error: te };

  const ids = {
    vivaTransactionId: field(body, 'TransactionId', 'transactionId') as string | undefined,
    vivaOrderCode: ((): string | undefined => {
      const oc = field(body, 'OrderCode', 'orderCode');
      return oc === undefined ? undefined : String(oc);
    })(),
  };

  if (status === 400 || status === 422) {
    return { approved: false, error: classifyDeclineError(body), ...ids };
  }

  const statusId = String(field(body, 'StatusId', 'statusId') ?? '');
  if (APPROVED_STATUS.has(statusId)) {
    return {
      approved: true,
      vivaTransactionId: ids.vivaTransactionId,
      vivaOrderCode: ids.vivaOrderCode,
      authorizationCode: field(body, 'RetrievalReferenceNumber', 'AuthorizationId', 'authorizationId', 'retrievalReferenceNumber'),
    };
  }

  return { approved: false, error: classifyDeclineError(body), ...ids };
}
