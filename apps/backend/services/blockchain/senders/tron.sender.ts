/**
 * PROJECT TITAN — Tron sender (Phase 6, thin)
 *
 * Wired as a drop-in: it builds the family-correct intent and validates inputs,
 * but the broadcast path is intentionally NOT_IMPLEMENTED until the Tron crypto-
 * exec lane lands. Because the engine selects senders by family and this honors
 * the same ChainSender contract, completing it later is a single-file change.
 */
import {
  ChainSender, NodeClient, BroadcastResult, SenderSendArgs,
} from '../sender.port';
import { getChain } from '../chains';

export class TronSender implements ChainSender {
  readonly family = 'TRON' as const;

  constructor(private readonly node: NodeClient) {}

  async send(args: SenderSendArgs): Promise<BroadcastResult> {
    const spec = getChain(args.chain);
    if (spec.family !== 'TRON') throw new Error(`TRON_SENDER_WRONG_FAMILY:${args.chain}`);
    if (args.amountBaseUnits <= 0n) throw new Error('AMOUNT_NOT_POSITIVE');
    // amount is integer SUN (6 dp); kept here for when build/broadcast is wired.
    throw new Error('NOT_IMPLEMENTED:TRON_BROADCAST');
  }
}
