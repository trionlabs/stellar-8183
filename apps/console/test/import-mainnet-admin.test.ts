import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { stellarSecretFromHex } from "../tools/import-mainnet-admin.js";

describe("Mainnet admin hexadecimal import", () => {
  it("encodes a 32-byte Ed25519 seed as a Stellar secret", () => {
    const secret = stellarSecretFromHex("07".repeat(32));
    expect(secret).toMatch(/^S[A-Z2-7]{55}$/);
    expect(Keypair.fromSecret(secret).rawSecretKey()).toEqual(
      Buffer.alloc(32, 7),
    );
  });

  it("accepts a 0x prefix and mixed case", () => {
    expect(stellarSecretFromHex(`0x${"aB".repeat(32)}`)).toBe(
      stellarSecretFromHex("ab".repeat(32)),
    );
  });

  it.each(["", "12", "gg".repeat(32), "ab".repeat(64)])(
    "rejects invalid or ambiguous input: %s",
    (value) => expect(() => stellarSecretFromHex(value)).toThrow("32-byte"),
  );
});
