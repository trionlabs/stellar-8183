import { Address, Keypair, Networks, StrKey } from "@stellar/stellar-sdk";
import { KeypairSigner } from "@stellar/stellar-sdk/contract";
import type {
  AuthorizationSigner,
  FacilitatorSigner,
} from "@trionlabs/stellar-8183";

export const TESTNET_USDC_CONTRACT =
  "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

export interface DemoConfig {
  readonly rpcUrl: string;
  readonly networkPassphrase: string;
  readonly kernelContractId: string;
  readonly tokenContractId: string;
  readonly hookContractId: string;
  readonly slaReviewSeconds: number;
  readonly budget: string;
  readonly maxFee: string;
  readonly expirySeconds: number;
  readonly refundExpirySeconds: number;
  readonly description: string;
  readonly deliverableUri: string;
  readonly rawEvidenceOutput: string;
  readonly deploymentEvidenceInput: string;
  readonly commitSha?: string;
  readonly kernelWasmSha256?: string;
  readonly hookWasmSha256?: string;
}

export interface DemoSigners {
  readonly admin: AuthorizationSigner;
  readonly client: AuthorizationSigner;
  readonly provider: AuthorizationSigner;
  readonly evaluator: AuthorizationSigner;
  readonly facilitator: FacilitatorSigner;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}

function optional(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const value = environment[name]?.trim();
  return value ? value : undefined;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function contractId(value: string, name: string): string {
  let parsed: Address;
  try {
    parsed = Address.fromString(value);
  } catch {
    throw new Error(`${name} must be a valid Stellar contract address`);
  }
  if (parsed.type !== "contract") {
    throw new Error(`${name} must be a C-address`);
  }
  return value;
}

function keypair(environment: NodeJS.ProcessEnv, name: string): Keypair {
  try {
    return Keypair.fromSecret(required(environment, name));
  } catch {
    throw new Error(`${name} must contain a valid Stellar secret seed`);
  }
}

export function loadDemoConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DemoConfig {
  const maxFee = required(environment, "MAX_FEE_STROOPS");
  if (!/^[1-9]\d*$/.test(maxFee)) {
    throw new Error("MAX_FEE_STROOPS must be a positive integer");
  }
  const networkPassphrase =
    environment.STELLAR_NETWORK_PASSPHRASE?.trim() || Networks.TESTNET;
  if (networkPassphrase !== Networks.TESTNET) {
    throw new Error(
      "the evidence demo is testnet-only and refuses any other network passphrase",
    );
  }
  const refundExpirySeconds = positiveInteger(
    environment.REFUND_EXPIRY_SECONDS?.trim() || "60",
    "REFUND_EXPIRY_SECONDS",
  );
  if (refundExpirySeconds > 180) {
    throw new Error(
      "REFUND_EXPIRY_SECONDS must not exceed 180 for the bounded testnet demo",
    );
  }
  return {
    rpcUrl:
      environment.STELLAR_RPC_URL?.trim() ||
      "https://soroban-testnet.stellar.org",
    networkPassphrase,
    kernelContractId: contractId(
      required(environment, "KERNEL_CONTRACT_ID"),
      "KERNEL_CONTRACT_ID",
    ),
    tokenContractId: contractId(
      environment.TOKEN_CONTRACT_ID?.trim() || TESTNET_USDC_CONTRACT,
      "TOKEN_CONTRACT_ID",
    ),
    hookContractId: contractId(
      required(environment, "SLA_HOOK_CONTRACT_ID"),
      "SLA_HOOK_CONTRACT_ID",
    ),
    slaReviewSeconds: positiveInteger(
      required(environment, "SLA_REVIEW_SECS"),
      "SLA_REVIEW_SECS",
    ),
    budget: environment.JOB_BUDGET?.trim() || "1",
    maxFee,
    expirySeconds: positiveInteger(
      environment.JOB_EXPIRY_SECONDS?.trim() || "900",
      "JOB_EXPIRY_SECONDS",
    ),
    refundExpirySeconds,
    description:
      environment.JOB_DESCRIPTION?.trim() ||
      "Analyze the supplied testnet commerce dataset",
    deliverableUri:
      environment.DELIVERABLE_URI?.trim() || "ipfs://stellar-8183-testnet-demo",
    rawEvidenceOutput:
      environment.RAW_EVIDENCE_OUTPUT?.trim() ||
      "artifacts/testnet-raw-capture.json",
    deploymentEvidenceInput:
      environment.DEPLOYMENT_EVIDENCE_INPUT?.trim() ||
      "artifacts/testnet/deployment-transactions.json",
    commitSha: optional(environment, "GIT_COMMIT"),
    kernelWasmSha256: optional(environment, "KERNEL_WASM_SHA256"),
    hookWasmSha256: optional(environment, "HOOK_WASM_SHA256"),
  };
}

export function loadDemoSigners(
  networkPassphrase: string,
  environment: NodeJS.ProcessEnv = process.env,
): DemoSigners {
  const keypairs = {
    admin: keypair(environment, "ADMIN_SECRET"),
    client: keypair(environment, "CLIENT_SECRET"),
    provider: keypair(environment, "PROVIDER_SECRET"),
    evaluator: keypair(environment, "EVALUATOR_SECRET"),
    facilitator: keypair(environment, "FACILITATOR_SECRET"),
  };
  const addresses = Object.values(keypairs).map((value) => value.publicKey());
  if (
    addresses.some((address) => !StrKey.isValidEd25519PublicKey(address)) ||
    new Set(addresses).size !== addresses.length
  ) {
    throw new Error(
      "admin, client, provider, evaluator, and facilitator must be distinct G-accounts",
    );
  }
  return {
    admin: new KeypairSigner(keypairs.admin, networkPassphrase),
    client: new KeypairSigner(keypairs.client, networkPassphrase),
    provider: new KeypairSigner(keypairs.provider, networkPassphrase),
    evaluator: new KeypairSigner(keypairs.evaluator, networkPassphrase),
    facilitator: new KeypairSigner(keypairs.facilitator, networkPassphrase),
  };
}
