import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { assertNoSecretEnvironment } from "../src/mainnet-authorization.js";
import { mainnetConfigDir } from "./mainnet-cli.js";

export function stellarSecretFromHex(value: string): string {
  const hex = value.trim().replace(/^0x/i, "");
  if (!/^[a-fA-F0-9]{64}$/.test(hex))
    throw new Error(
      "Hex input must be exactly 64 hexadecimal characters (a 32-byte Ed25519 seed).",
    );
  return StrKey.encodeEd25519SecretSeed(Buffer.from(hex, "hex"));
}

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  assertNoSecretEnvironment(process.env);
  const root = resolve(import.meta.dirname, "../../..");
  const secret = stellarSecretFromHex(await readStandardInput());
  const address = Keypair.fromSecret(secret).publicKey();
  const child = spawn(
    "stellar",
    [
      "--config-dir",
      mainnetConfigDir(root),
      "keys",
      "add",
      "canary-admin",
      "--secret-key",
    ],
    { cwd: root, stdio: ["pipe", "inherit", "inherit"] },
  );
  child.stdin.end(`${secret}\n`);
  const code = await new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  });
  if (code !== 0) throw new Error("Stellar CLI did not import canary-admin.");
  console.log(`Imported canary-admin address: ${address}`);
}

if (process.argv[1]?.endsWith("import-mainnet-admin.ts")) await main();
