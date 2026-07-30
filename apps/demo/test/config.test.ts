import { Address, Keypair, Networks } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import {
  TESTNET_USDC_CONTRACT,
  loadDemoConfig,
  loadDemoSigners,
} from "../src/config.js";

const contractId = Address.contract(Buffer.alloc(32, 4)).toString();
const hookContractId = Address.contract(Buffer.alloc(32, 5)).toString();
const publicEnvironment = {
  KERNEL_CONTRACT_ID: contractId,
  SLA_HOOK_CONTRACT_ID: hookContractId,
  SLA_REVIEW_SECS: "300",
  MAX_FEE_STROOPS: "1000000",
};

describe("testnet demo configuration", () => {
  it("defaults only public, non-secret settings", () => {
    const config = loadDemoConfig(publicEnvironment);
    expect(config).toMatchObject({
      kernelContractId: contractId,
      tokenContractId: TESTNET_USDC_CONTRACT,
      networkPassphrase: Networks.TESTNET,
      budget: "1",
      hookContractId,
      slaReviewSeconds: 300,
    });
    expect(JSON.stringify(config)).not.toMatch(/SECRET|seed/i);
  });

  it("requires five distinct valid signer seeds", () => {
    const shared = Keypair.random().secret();
    expect(() =>
      loadDemoSigners(Networks.TESTNET, {
        ADMIN_SECRET: Keypair.random().secret(),
        CLIENT_SECRET: shared,
        PROVIDER_SECRET: shared,
        EVALUATOR_SECRET: Keypair.random().secret(),
        FACILITATOR_SECRET: Keypair.random().secret(),
      }),
    ).toThrow(/distinct/);
  });

  it("returns callbacks and public addresses, never raw seeds", () => {
    const environment = {
      ADMIN_SECRET: Keypair.random().secret(),
      CLIENT_SECRET: Keypair.random().secret(),
      PROVIDER_SECRET: Keypair.random().secret(),
      EVALUATOR_SECRET: Keypair.random().secret(),
      FACILITATOR_SECRET: Keypair.random().secret(),
    };
    const signers = loadDemoSigners(Networks.TESTNET, environment);
    expect(
      new Set(Object.values(signers).map(({ address }) => address)).size,
    ).toBe(5);
    expect(JSON.stringify(signers)).not.toContain(environment.CLIENT_SECRET);
  });

  it("requires an explicit positive facilitator fee ceiling", () => {
    expect(() => loadDemoConfig({ KERNEL_CONTRACT_ID: contractId })).toThrow(
      /MAX_FEE_STROOPS/,
    );
    expect(() =>
      loadDemoConfig({
        ...publicEnvironment,
        MAX_FEE_STROOPS: "0",
      }),
    ).toThrow(/positive integer/);
  });

  it("requires the SLA hook and its expected review window", () => {
    expect(() =>
      loadDemoConfig({
        KERNEL_CONTRACT_ID: contractId,
        MAX_FEE_STROOPS: "1000000",
      }),
    ).toThrow(/SLA_HOOK_CONTRACT_ID/);
  });

  it("refuses non-testnet networks and unbounded refund waits", () => {
    expect(() =>
      loadDemoConfig({
        ...publicEnvironment,
        STELLAR_NETWORK_PASSPHRASE: Networks.PUBLIC,
      }),
    ).toThrow(/testnet-only/);
    expect(() =>
      loadDemoConfig({
        ...publicEnvironment,
        REFUND_EXPIRY_SECONDS: "181",
      }),
    ).toThrow(/must not exceed 180/);
  });
});
