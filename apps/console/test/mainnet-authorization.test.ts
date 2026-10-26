import { describe, expect, it } from "vitest";
import {
  assertNoSecretEnvironment,
  parseMainnetAuthorization,
} from "../src/mainnet-authorization.js";

const valid = () => ({
  schema: "stellar-8183/mainnet-authorization/v1",
  sourceCommit: "ab".repeat(20),
  kernelWasmSha256: "cd".repeat(32),
  hookWasmSha256: "ef".repeat(32),
  chapterLeadApproval: {
    approver: "Chapter Lead",
    reference: "message-reference-123",
    approvedAt: "2026-10-26T12:00:00Z",
    valuelessCanaryAccepted: true,
  },
  independentAudit: {
    reviewer: "Independent Reviewer",
    reference: "audit-report-123",
    completedAt: "2026-10-26T13:00:00Z",
    independentFromBuilder: true,
    unresolvedCritical: 0,
    unresolvedHigh: 0,
  },
  threatModelReview: {
    approver: "Release Owner",
    reference: "threat-review-123",
    approvedAt: "2026-10-26T14:00:00Z",
    approved: true,
  },
});

describe("Mainnet authorization gate", () => {
  it("accepts a source-bound approval with a clean independent audit", () => {
    expect(parseMainnetAuthorization(JSON.stringify(valid()))).toEqual(valid());
  });

  it.each([
    [
      "Chapter Lead approval",
      {
        chapterLeadApproval: {
          ...valid().chapterLeadApproval,
          valuelessCanaryAccepted: false,
        },
      },
    ],
    [
      "independent audit",
      {
        independentAudit: {
          ...valid().independentAudit,
          independentFromBuilder: false,
        },
      },
    ],
    [
      "critical finding",
      {
        independentAudit: {
          ...valid().independentAudit,
          unresolvedCritical: 1,
        },
      },
    ],
    [
      "high finding",
      { independentAudit: { ...valid().independentAudit, unresolvedHigh: 1 } },
    ],
    [
      "threat approval",
      { threatModelReview: { ...valid().threatModelReview, approved: false } },
    ],
  ])("rejects a missing %s gate", (_label, changed) => {
    expect(() =>
      parseMainnetAuthorization(JSON.stringify({ ...valid(), ...changed })),
    ).toThrow();
  });

  it("rejects placeholders, changed hashes, extra fields, and future approvals", () => {
    expect(() =>
      parseMainnetAuthorization(
        JSON.stringify({
          ...valid(),
          chapterLeadApproval: {
            ...valid().chapterLeadApproval,
            reference: "TBD",
          },
        }),
      ),
    ).toThrow("placeholder");
    expect(() =>
      parseMainnetAuthorization(
        JSON.stringify({ ...valid(), kernelWasmSha256: "wrong" }),
      ),
    ).toThrow("Kernel Wasm hash");
    expect(() =>
      parseMainnetAuthorization(JSON.stringify({ ...valid(), extra: true })),
    ).toThrow("unexpected");
    expect(() =>
      parseMainnetAuthorization(
        JSON.stringify({
          ...valid(),
          threatModelReview: {
            ...valid().threatModelReview,
            approvedAt: "2999-01-01T00:00:00Z",
          },
        }),
      ),
    ).toThrow("future");
  });

  it("refuses signing material in process environment variables", () => {
    expect(() => assertNoSecretEnvironment({})).not.toThrow();
    for (const key of [
      "STELLAR_ACCOUNT",
      "STELLAR_SIGN_WITH_KEY",
      "STELLAR_SECRET_KEY",
      "MAINNET_PRIVATE_KEY",
      "MAINNET_SEED_PHRASE",
    ])
      expect(() => assertNoSecretEnvironment({ [key]: "sensitive" })).toThrow(
        "secure-store",
      );
  });
});
