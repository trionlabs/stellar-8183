export interface CommerceBalances {
  readonly client: bigint;
  readonly provider: bigint;
  readonly evaluator: bigint;
  readonly escrow: bigint;
}

export function assertNoNetTokenMovement(
  label: string,
  before: CommerceBalances,
  after: CommerceBalances,
): void {
  for (const role of ["client", "provider", "evaluator", "escrow"] as const) {
    if (after[role] !== before[role]) {
      throw new Error(
        `${label} unexpectedly changed ${role} token balance by ${
          after[role] - before[role]
        }`,
      );
    }
  }
}

export function assertCompletionTokenMovement(
  before: CommerceBalances,
  after: CommerceBalances,
  budget: bigint,
): void {
  if (after.client - before.client !== -budget) {
    throw new Error("client token delta does not equal the funded budget");
  }
  if (after.provider - before.provider !== budget) {
    throw new Error("provider token delta does not equal the settled budget");
  }
  if (after.evaluator !== before.evaluator) {
    throw new Error("evaluator token balance changed during completion");
  }
  if (after.escrow !== before.escrow) {
    throw new Error("escrow retained funds after completion");
  }
}
