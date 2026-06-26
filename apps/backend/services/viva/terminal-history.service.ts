/**
 * PROJECT TITAN — QueryTerminalHistory use-case (APPLICATION layer).
 * Terminal-scoped, paginated, newest-first history for reporting / receipt reprint.
 */
import { QueryTerminalHistoryUseCase, LedgerRepository } from './ports';
import { TransactionRecord } from './domain';

const MAX_LIMIT = 200;

export class TerminalHistoryService implements QueryTerminalHistoryUseCase {
  constructor(private readonly ledger: LedgerRepository) {}

  async byTerminal(terminalId: string, limit: number, offset: number): Promise<TransactionRecord[]> {
    const safeLimit = Math.min(Math.max(1, Math.floor(limit) || 50), MAX_LIMIT);
    const safeOffset = Math.max(0, Math.floor(offset) || 0);
    return this.ledger.findByTerminal(terminalId, safeLimit, safeOffset);
  }
}
