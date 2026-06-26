/**
 * PROJECT TITAN — Solana sender (Phase 6, thin)
 *
 * Wired as a drop-in like TronSender: validates inputs and honors the
 * ChainSender contract, but broadcast is NOT_IMPLEMENTED until the Solana
 * crypto-exec lane lands. Amounts are integer LAMPORT (9 dp).
 */
import {
  ChainSender, NodeClient, BroadcastResult, SenderSendArgs,
} from '../sender.port';
import { getChain } from '../chains';

export class SolanaSender implements ChainSender {
  readonly family = 'SOLANA' as const;

  constructor(private readonly node: NodeClient) {}

  async send(args: SenderSendArgs): Promise<BroadcastResult> {
    const spec = getChain(args.chain);
    if (spec.family !== 'SOLANA') throw new Error(`SOLANA_SENDER_WRONG_FAMILY:${args.chain}`);
    if (args.amountBaseUnits <= 0n) throw new Error('AMOUNT_NOT_POSITIVE');
    throw new Error('NOT_IMPLEMENTED:SOLANA_BROADCAST');
  }
}
