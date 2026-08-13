#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const requireFromSdk = createRequire(
  resolve(WORKSPACE_ROOT, "packages/sdk/package.json"),
);

function fail(message) {
  throw new Error(`deployment capture failed: ${message}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function normalizeCreatedAt(value) {
  const normalized =
    typeof value === "string" && /^[1-9]\d*$/.test(value)
      ? Number(value)
      : value;
  if (
    typeof normalized !== "number" ||
    !Number.isSafeInteger(normalized) ||
    normalized <= 0
  ) {
    fail("RPC returned an invalid transaction close timestamp");
  }
  return normalized;
}

function hashArguments(arguments_) {
  const framed = [];
  for (const argument of arguments_) {
    const bytes = argument.toXDR();
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    framed.push(length, bytes);
  }
  return sha256(Buffer.concat(framed));
}

function parseArguments(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (
      key === undefined ||
      value === undefined ||
      !key.startsWith("--") ||
      key in parsed
    ) {
      fail("arguments must be unique --name value pairs");
    }
    parsed[key.slice(2)] = value;
  }
  const required = [
    "rpc-url",
    "network-passphrase",
    "admin",
    "kernel-id",
    "kernel-hash",
    "hook-id",
    "hook-hash",
    "admit-hash",
    "output",
  ];
  const keys = Object.keys(parsed);
  if (
    required.some((key) => !(key in parsed)) ||
    keys.some((key) => !required.includes(key))
  ) {
    fail(`expected exactly: ${required.map((key) => `--${key}`).join(" ")}`);
  }
  return parsed;
}

function resourceUsage(transaction, sdk) {
  const envelope = transaction.toEnvelope();
  if (envelope.switch().value !== sdk.xdr.EnvelopeType.envelopeTypeTx().value) {
    fail("fee-bump deployment envelopes are outside the evidence profile");
  }
  const extension = envelope.v1().tx().ext();
  if (extension.switch() !== 1) {
    fail("deployment transaction omitted Soroban resource data");
  }
  const data = extension.sorobanData();
  const resources = data.resources();
  const resourceFee = BigInt(data.resourceFee().toString());
  const totalFee = BigInt(transaction.fee);
  if (resourceFee < 0n || totalFee < resourceFee) {
    fail("deployment transaction contains inconsistent resource fees");
  }
  return {
    usage: {
      instructions: resources.instructions(),
      readBytes: resources.diskReadBytes(),
      writeBytes: resources.writeBytes(),
      readOnlyEntries: resources.footprint().readOnly().length,
      readWriteEntries: resources.footprint().readWrite().length,
      declaredResourceFee: resourceFee.toString(),
      inclusionFee: (totalFee - resourceFee).toString(),
      totalFee: totalFee.toString(),
    },
    minResourceFee: resourceFee.toString(),
  };
}

function invocationDetails(transaction, expected, sdk) {
  if (transaction.operations.length !== 1) {
    fail(`${expected.label} must contain exactly one operation`);
  }
  const operation = transaction.operations[0];
  if (
    operation.type !== "invokeHostFunction" ||
    operation.source !== undefined
  ) {
    fail(`${expected.label} must contain one source-less host function`);
  }
  const hostFunction = operation.func;
  let arguments_;
  if (expected.method === "__constructor") {
    if (
      hostFunction.switch().value !==
      sdk.xdr.HostFunctionType.hostFunctionTypeCreateContractV2().value
    ) {
      fail(`${expected.label} is not a createContractV2 operation`);
    }
    arguments_ = hostFunction.createContractV2().constructorArgs();
  } else {
    if (
      hostFunction.switch().value !==
      sdk.xdr.HostFunctionType.hostFunctionTypeInvokeContract().value
    ) {
      fail(`${expected.label} is not an invoke-contract operation`);
    }
    const invocation = hostFunction.invokeContract();
    const actualContract = sdk.Address.fromScAddress(
      invocation.contractAddress(),
    ).toString();
    if (
      actualContract !== expected.contractId ||
      invocation.functionName().toString() !== expected.method
    ) {
      fail(`${expected.label} targets an unexpected contract or method`);
    }
    arguments_ = invocation.args();
  }
  const authorizers = [];
  for (const entry of operation.auth ?? []) {
    const address = sdk.inspectAuthEntry(entry).address;
    if (address !== null) {
      authorizers.push(address);
    }
  }
  return {
    argumentsSha256: hashArguments(arguments_),
    authorizers: [...new Set(authorizers)].sort(),
  };
}

async function captureOne(server, expected, options, sdk, decodeContractEvent) {
  const response = await server.getTransaction(expected.hash);
  if (
    response.status !== sdk.rpc.Api.GetTransactionStatus.SUCCESS ||
    response.txHash !== expected.hash
  ) {
    fail(`${expected.label} is not a successful retained RPC transaction`);
  }
  const envelopeXdr = response.envelopeXdr.toXDR("base64");
  const transaction = sdk.TransactionBuilder.fromXDR(
    envelopeXdr,
    options.networkPassphrase,
  );
  if (!(transaction instanceof sdk.Transaction)) {
    fail(`${expected.label} returned a fee-bump transaction`);
  }
  if (
    transaction.hash().toString("hex") !== expected.hash ||
    transaction.source !== options.admin
  ) {
    fail(`${expected.label} hash or source does not match the trusted input`);
  }
  const invocation = invocationDetails(transaction, expected, sdk);
  const resources = resourceUsage(transaction, sdk);
  const createdAt = normalizeCreatedAt(response.createdAt);
  const contractEventObjects = response.events.contractEventsXdr.flat();
  const contractEventsXdr = contractEventObjects.map((event) =>
    event.toXDR("base64"),
  );
  const decodedEvents = [];
  for (const event of contractEventObjects) {
    if (event.contractId() === null) {
      continue;
    }
    decodedEvents.push(decodeContractEvent(event.toXDR("base64")));
  }
  return {
    label: expected.label,
    method: expected.method,
    hash: response.txHash,
    explorerUrl: `https://stellar.expert/explorer/testnet/tx/${response.txHash}`,
    ledger: response.ledger,
    createdAt,
    closedAt: new Date(createdAt * 1_000).toISOString(),
    fee: transaction.fee,
    minResourceFee: resources.minResourceFee,
    resources: resources.usage,
    source: transaction.source,
    contractId: expected.contractId,
    authorizers: invocation.authorizers,
    argumentsSha256: invocation.argumentsSha256,
    envelopeSha256: sha256(Buffer.from(envelopeXdr, "base64")),
    returnValueXdr: response.returnValue?.toXDR("base64"),
    resultXdr: response.resultXdr.toXDR("base64"),
    contractEventsXdr,
    decodedEvents,
    balanceChanges: [],
  };
}

export async function captureDeploymentTransactions(arguments_) {
  const sdk = requireFromSdk("@stellar/stellar-sdk");
  const { decodeContractEvent } = await import(
    pathToFileURL(resolve(WORKSPACE_ROOT, "packages/sdk/dist/index.js")).href
  );
  if (arguments_.networkPassphrase !== sdk.Networks.TESTNET) {
    fail("only the Stellar testnet passphrase is accepted");
  }
  if (!sdk.StrKey.isValidEd25519PublicKey(arguments_.admin)) {
    fail("--admin must be a G-address");
  }
  for (const [label, value] of [
    ["kernel-id", arguments_.kernelId],
    ["hook-id", arguments_.hookId],
  ]) {
    let address;
    try {
      address = sdk.Address.fromString(value);
    } catch {
      fail(`--${label} must be a C-address`);
    }
    if (address.type !== "contract") {
      fail(`--${label} must be a C-address`);
    }
  }
  for (const [label, value] of [
    ["kernel-hash", arguments_.kernelHash],
    ["hook-hash", arguments_.hookHash],
    ["admit-hash", arguments_.admitHash],
  ]) {
    if (!/^[0-9a-f]{64}$/.test(value)) {
      fail(`--${label} must be a lowercase transaction hash`);
    }
  }
  const server = new sdk.rpc.Server(arguments_.rpcUrl);
  const network = await server.getNetwork();
  if (network.passphrase !== arguments_.networkPassphrase) {
    fail("RPC passphrase does not match the trusted testnet passphrase");
  }
  const expected = [
    {
      label: "deploy_kernel",
      method: "__constructor",
      hash: arguments_.kernelHash,
      contractId: arguments_.kernelId,
    },
    {
      label: "deploy_sla_hook",
      method: "__constructor",
      hash: arguments_.hookHash,
      contractId: arguments_.hookId,
    },
    {
      label: "admit_hook",
      method: "set_hook",
      hash: arguments_.admitHash,
      contractId: arguments_.kernelId,
    },
  ];
  const captured = [];
  for (const transaction of expected) {
    captured.push(
      await captureOne(
        server,
        transaction,
        arguments_,
        sdk,
        decodeContractEvent,
      ),
    );
  }
  return captured;
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  const options = {
    rpcUrl: parsed["rpc-url"],
    networkPassphrase: parsed["network-passphrase"],
    admin: parsed.admin,
    kernelId: parsed["kernel-id"],
    kernelHash: parsed["kernel-hash"],
    hookId: parsed["hook-id"],
    hookHash: parsed["hook-hash"],
    admitHash: parsed["admit-hash"],
  };
  const captured = await captureDeploymentTransactions(options);
  writeFileSync(parsed.output, `${JSON.stringify(captured, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(`Wrote ${captured.length} deployment transactions.\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
