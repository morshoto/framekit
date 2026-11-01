import type { EditTransaction } from "../domain/editing.js";

export interface TransactionStore {
  set(transaction: EditTransaction): void;
  get(transactionId: string): EditTransaction;
}

export class InMemoryTransactionStore implements TransactionStore {
  private readonly transactions = new Map<string, EditTransaction>();

  public set(transaction: EditTransaction): void {
    this.transactions.set(transaction.id, transaction);
  }

  public get(transactionId: string): EditTransaction {
    const transaction = this.transactions.get(transactionId);
    if (!transaction) throw new Error(`TRANSACTION_NOT_FOUND: ${transactionId}`);
    return transaction;
  }
}
