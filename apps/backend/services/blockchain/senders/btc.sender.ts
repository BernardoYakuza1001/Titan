/**
 * PROJECT TITAN — Bitcoin sender (Phase 6)
 *
 * Builds a transfer of `amountBaseUnits` SATOSHI to a validated destination and
 * broadcasts it through the injected NodeClient. The actual UTXO selection /
 * signing is owned by the crypto-exec engine + NodeClient provider; this sender
 * assembles the family-correct BroadcastIntent (amounts as integer satoshi
 * strings, a resolved fee rate) and pushes it.
 *
 * No floats touch the amount. Fee rate is carried as a decimal STRING.
 */
import {
  ChainSender, NodeClient, BroadcastResult, SenderSendArgs, BroadcastIntent,
} from '../sender.port';
import { getChain } from '../chains';

export class BtcSender implements ChainSender {
  readonly family = 'BTC' as const;

  constructor(private readonly node: NodeClient) {}

  async send(args: SenderSendArgs): Promise<BroadcastResult> {
    const spec = getChain(args.chain);
    if (spec.family !== 'BTC') throw new Error(`BTC_SENDER_WRONG_FAMILY:${args.chain}`);
    if (args.amountBaseUnits <= 0n) throw new Error('AMOUNT_NOT_POSITIVE');

    const fee = await this.node.suggestFee();
    const intent: BroadcastIntent = {
      deliveryId: args.deliveryId,
      chain: spec.id,
      family: 'BTC',
      to: args.to,
      amountBaseUnits: args.amountBaseUnits.toString(), // satoshi
      fee,
    };
    return this.node.broadcast(intent);
  }
}
