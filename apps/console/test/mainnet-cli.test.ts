import { describe, expect, it } from "vitest";
import {
  Account,
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { secureStoreWallet } from "../tools/mainnet-cli.js";
import type { Profile } from "../src/model.js";

const source = Keypair.random().publicKey();
const other = Keypair.random().publicKey();
const contract = StrKey.encodeContract(Buffer.alloc(32, 7));
const profile: Profile = {
  id: "mainnet-canary",
  rpcUrl: "https://example.com",
  networkPassphrase: Networks.PUBLIC,
  kernel: contract,
  token: contract,
  symbol: "DEMO8183",
  decimals: 7,
  maxFee: "10000000",
  canaryAcknowledged: true,
};
const transaction = new TransactionBuilder(new Account(source, "1"), {
  fee: "100",
  networkPassphrase: Networks.PUBLIC,
})
  .setTimeout(60)
  .build()
  .toXDR();

describe("Mainnet secure-store signer", () => {
  it("accepts only the four fixed canary aliases", () => {
    expect(() => secureStoreWallet("/tmp", "unknown", source)).toThrow(
      "Unknown",
    );
  });

  it("rejects an invalid signer address", () => {
    expect(() =>
      secureStoreWallet("/tmp", "canary-client", "not-an-address"),
    ).toThrow("G-account");
  });

  it("refuses non-canary profiles before invoking the CLI", async () => {
    const wallet = secureStoreWallet("/tmp", "canary-client", source);
    await expect(
      wallet.sign(transaction, { ...profile, id: "testnet" }),
    ).rejects.toThrow("restricted");
  });

  it("refuses a transaction sourced by another account", async () => {
    const wallet = secureStoreWallet("/tmp", "canary-client", other);
    await expect(wallet.sign(transaction, profile)).rejects.toThrow(
      "does not match",
    );
  });
});
