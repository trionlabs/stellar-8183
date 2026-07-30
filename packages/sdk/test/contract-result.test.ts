import { Err, Ok } from "@stellar/stellar-sdk/contract";
import { describe, expect, it } from "vitest";

import {
  AgenticCommerceError,
  methodReturnsContractResult,
  unwrapContractResult,
} from "../src/index.js";

describe("generated Rust Result handling", () => {
  it("unwraps Ok values without casting away the generated type", () => {
    expect(unwrapContractResult(new Ok(42n), "create_job")).toBe(42n);
  });

  it("surfaces Err values with a stable SDK code", () => {
    const error = new Err({ message: "InvalidState" });
    expect(() => unwrapContractResult(error, "get_job")).toThrow(
      AgenticCommerceError,
    );
    try {
      unwrapContractResult(error, "get_job");
    } catch (caught) {
      expect(caught).toMatchObject({
        code: "CONTRACT_ERROR",
        message: "InvalidState",
      });
    }
  });

  it("distinguishes bare-return ABI methods", () => {
    expect(methodReturnsContractResult("create_job")).toBe(true);
    expect(methodReturnsContractResult("get_job")).toBe(true);
    expect(methodReturnsContractResult("propose_admin")).toBe(false);
    expect(methodReturnsContractResult("set_hook")).toBe(false);
    expect(methodReturnsContractResult("job_count")).toBe(false);
  });
});
