import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import {
  Networks,
  StrKey,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import type { Wallet } from "../src/live.js";
import type { Profile } from "../src/model.js";
import { assertNoSecretEnvironment } from "../src/mainnet-authorization.js";

const execute = promisify(execFile);

export const MAINNET_ALIASES = {
  admin: "canary-deployer",
  client: "canary-client",
  provider: "canary-provider",
  evaluator: "canary-evaluator",
} as const;

export type MainnetRole = keyof typeof MAINNET_ALIASES;

export function mainnetConfigDir(repositoryRoot: string): string {
  return resolve(repositoryRoot, ".stellar/mainnet-canary");
}

export async function stellarCli(
  repositoryRoot: string,
  args: string[],
  timeout = 180_000,
): Promise<string> {
  assertNoSecretEnvironment(process.env);
  try {
    const { stdout } = await execute(
      "stellar",
      ["--config-dir", mainnetConfigDir(repositoryRoot), "--quiet", ...args],
      {
        cwd: repositoryRoot,
        timeout,
        maxBuffer: 5_000_000,
      },
    );
    return stdout.trim();
  } catch (cause) {
    const error = cause as { code?: unknown; stderr?: unknown };
    const detail =
      typeof error.stderr === "string"
        ? error.stderr
            .split("\n")
            .filter((line) => !/\bS[A-Z2-7]{55}\b/.test(line))
            .slice(-4)
            .join("\n")
            .trim()
        : "";
    throw new Error(
      `Stellar CLI failed at ${args.slice(0, 4).join(" ")}.${detail ? ` ${detail}` : ""}`,
    );
  }
}

export async function mainnetAddresses(
  repositoryRoot: string,
): Promise<Record<MainnetRole, string>> {
  const pairs = await Promise.all(
    (Object.entries(MAINNET_ALIASES) as [MainnetRole, string][]).map(
      async ([role, alias]) => {
        const value = await stellarCli(repositoryRoot, [
          "keys",
          "address",
          alias,
        ]);
        if (!StrKey.isValidEd25519PublicKey(value))
          throw new Error(`${alias} did not resolve to a public G-account.`);
        return [role, value] as const;
      },
    ),
  );
  const addresses = Object.fromEntries(pairs) as Record<MainnetRole, string>;
  if (new Set(Object.values(addresses)).size !== Object.keys(addresses).length)
    throw new Error("Every Mainnet canary role must use a distinct account.");
  return addresses;
}

export function secureStoreWallet(
  repositoryRoot: string,
  alias: string,
  address: string,
): Wallet {
  if (!Object.values(MAINNET_ALIASES).includes(alias as never))
    throw new Error("Unknown Mainnet canary signing alias.");
  if (!StrKey.isValidEd25519PublicKey(address))
    throw new Error("Mainnet signer requires a public G-account.");
  return {
    address,
    sign: async (xdr: string, profile: Profile): Promise<string> => {
      if (
        profile.id !== "mainnet-canary" ||
        profile.networkPassphrase !== Networks.PUBLIC ||
        profile.canaryAcknowledged !== true
      )
        throw new Error(
          "Secure-store signing is restricted to Mainnet canary.",
        );
      const unsigned = TransactionBuilder.fromXDR(xdr, Networks.PUBLIC);
      if (!(unsigned instanceof Transaction) || unsigned.source !== address)
        throw new Error("Signing alias does not match the transaction source.");
      const signed = await stellarCli(repositoryRoot, [
        "tx",
        "sign",
        xdr,
        "--sign-with-key",
        alias,
        "--network",
        "mainnet",
      ]);
      TransactionBuilder.fromXDR(signed, Networks.PUBLIC);
      return signed;
    },
  };
}
