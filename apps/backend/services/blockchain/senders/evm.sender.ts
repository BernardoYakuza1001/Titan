/**
 * PROJECT TITAN — EVM sender (Phase 6)
 *
 * ONE sender covers ETH / Polygon / Arbitrum / Optimism / Base / BNB — they are
 * the same family and differ only by `evmChainId` (EIP-155), which pins the
 * network and prevents cross-chain replay. Builds a native-value transfer of
 * `amountBaseUnits` WEI to a checksummed destination and broadcasts it via the
 * injected NodeClient.
 *
 * The destination is re-checksummed to canonical EIP-55 here as defense-in-depth
 * even though the engine already validated it. Amounts stay integer (BigInt);
 * gas params are decimal STRINGS — never floats.
 */
import {
  ChainSender, NodeClient, BroadcastResult, SenderSendArgs, BroadcastIntent,
} from '../sender.port';
import { getChain } from '../chains';
import { checksumEvmAddress } from '../address/evm';

export class EvmSender implements ChainSender {
  readonly family = 'EVM' as const;

  constructor(private readonly node: NodeClient) {}

  async send(args: SenderSendArgs): Promise<BroadcastResult> {
    const spec = getChain(args.chain);
    if (spec.family !== 'EVM') throw new Error(`EVM_SENDER_WRONG_FAMILY:${args.chain}`);
    if (args.amountBaseUnits <= 0n) throw new Error('AMOUNT_NOT_POSITIVE');

    // Pin the network: prefer the explicit arg, else the registry's chain id.
    const evmChainId = args.evmChainId ?? spec.evmChainId;
    if (evmChainId === undefined) throw new Error(`EVM_CHAIN_ID_MISSING:${args.chain}`);

    const fee = await this.node.suggestFee();
    const intent: BroadcastIntent = {
      deliveryId: args.deliveryId,
      chain: spec.id,
      family: 'EVM',
      to: checksumEvmAddress(args.to),
      amountBaseUnits: args.amountBaseUnits.toString(), // wei
      evmChainId,
      fee,
    };
    return this.node.broadcast(intent);
  }
}
