export interface Balances {
  client: string;
  provider: string;
  evaluator: string;
  escrow: string;
}
export interface BalanceAccounting {
  jobId: string;
  fundingTransaction: string;
  initial: Balances;
  funded: Balances;
  terminal: Balances;
}
export function verifyBalanceAccounting(
  record: BalanceAccounting,
  budget: bigint,
  completed: boolean,
): void {
  if (
    !record ||
    Object.keys(record).sort().join() !==
      "funded,fundingTransaction,initial,jobId,terminal"
  )
    throw new Error("Unexpected balance accounting fields.");
  for (const snapshot of [record.initial, record.funded, record.terminal]) {
    if (
      !snapshot ||
      Object.keys(snapshot).sort().join() !== "client,escrow,evaluator,provider"
    )
      throw new Error("Invalid balance snapshot.");
    for (const value of Object.values(snapshot))
      if (
        typeof value !== "string" ||
        !/^(0|[1-9][0-9]*)$/.test(value) ||
        BigInt(value) > (1n << 127n) - 1n
      )
        throw new Error("Invalid token balance.");
  }
  const a = record.initial,
    b = record.funded,
    c = record.terminal;
  const equal = (left: string, right: string, delta = 0n): boolean =>
    BigInt(left) === BigInt(right) + delta;
  if (
    !equal(b.client, a.client, -budget) ||
    !equal(b.escrow, a.escrow, budget) ||
    b.provider !== a.provider ||
    b.evaluator !== a.evaluator
  )
    throw new Error(
      "Funding balance accounting does not match the exact budget.",
    );
  if (
    !equal(c.client, a.client, completed ? -budget : 0n) ||
    !equal(c.provider, a.provider, completed ? budget : 0n) ||
    c.evaluator !== a.evaluator ||
    c.escrow !== a.escrow
  )
    throw new Error(
      "Terminal balance accounting does not conserve the budget.",
    );
}
