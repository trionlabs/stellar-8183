import { describe, expect, it } from "vitest";

import {
  assertCompletionTokenMovement,
  assertNoNetTokenMovement,
} from "../src/accounting.js";

describe("scenario token accounting", () => {
  it("accepts exact completion conservation", () => {
    expect(() =>
      assertCompletionTokenMovement(
        { client: 10n, provider: 2n, evaluator: 3n, escrow: 0n },
        { client: 5n, provider: 7n, evaluator: 3n, escrow: 0n },
        5n,
      ),
    ).not.toThrow();
  });

  it("rejects retained escrow or an incomplete refund", () => {
    expect(() =>
      assertCompletionTokenMovement(
        { client: 10n, provider: 2n, evaluator: 3n, escrow: 0n },
        { client: 5n, provider: 6n, evaluator: 3n, escrow: 1n },
        5n,
      ),
    ).toThrow(/provider token delta/);
    expect(() =>
      assertNoNetTokenMovement(
        "refund",
        { client: 10n, provider: 2n, evaluator: 3n, escrow: 0n },
        { client: 9n, provider: 2n, evaluator: 3n, escrow: 1n },
      ),
    ).toThrow(/refund unexpectedly changed client/);
  });
});
