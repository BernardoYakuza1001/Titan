/**
 * PROJECT TITAN — Sender barrel + family wiring (Phase 6)
 *
 * Builds the family -> ChainSender map the engine dispatches on. Each family's
 * sender is constructed from the NodeClient resolved for the destination chain.
 * Adding a new family sender (or completing Tron/Solana) is a one-line change
 * here plus the concrete file — nothing else in the engine moves.
 */
import { ChainFamily } from '../chains';
import { ChainSender, NodeClient } from '../sender.port';
import { BtcSender } from './btc.sender';
import { EvmSender } from './evm.sender';
import { TronSender } from './tron.sender';
import { SolanaSender } from './solana.sender';

export { BtcSender } from './btc.sender';
export { EvmSender } from './evm.sender';
export { TronSender } from './tron.sender';
export { SolanaSender } from './solana.sender';

/** Construct the per-family sender set bound to a given NodeClient. */
export function buildSenders(node: NodeClient): Record<ChainFamily, ChainSender> {
  return {
    BTC: new BtcSender(node),
    EVM: new EvmSender(node),
    TRON: new TronSender(node),
    SOLANA: new SolanaSender(node),
  };
}
