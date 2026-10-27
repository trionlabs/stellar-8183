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

export function normalizeMnemonic(value: string): string {
  const words = value
    .normalize("NFKD")
    .replace(/(?:^|\s)\d{1,2}[.)]\s*/g, " ")
    .replace(/[,\r\n\t]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").toLowerCase())
    .filter(Boolean);
  if (words.length !== 12 && words.length !== 24)
    throw new Error("Recovery phrase must contain exactly 12 or 24 words.");
  return words.join(" ");
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
  const input = await readStandardInput();
  const mnemonic = process.argv[2] === "mnemonic";
  if (!mnemonic && process.argv[2] !== "hex")
    throw new Error("Import mode must be mnemonic or hex.");
  const secret = mnemonic
    ? normalizeMnemonic(input)
    : stellarSecretFromHex(input);
  const address = mnemonic ? undefined : Keypair.fromSecret(secret).publicKey();
  const child = spawn(
    "stellar",
    [
      "--config-dir",
      mainnetConfigDir(root),
      "keys",
      "add",
      "canary-admin",
      mnemonic ? "--secure-store" : "--secret-key",
    ],
    { cwd: root, stdio: ["pipe", "inherit", "inherit"] },
  );
  child.stdin.end(`${secret}\n`);
  const code = await new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  });
  if (code !== 0) throw new Error("Stellar CLI did not import canary-admin.");
  if (address) console.log(`Imported canary-admin address: ${address}`);
  else
    console.log(
      "Imported canary-admin recovery phrase into the OS secure store.",
    );
}

if (process.argv[1]?.endsWith("import-mainnet-admin.ts")) await main();
