import { Address, hash } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";

import { commitmentToHex } from "./commitment.js";
import { invariant } from "./errors.js";
import type { Job } from "./kernel-types.js";
import type { RelayReceipt } from "./relay/types.js";

export interface EvidenceConfig {
  readonly network: "testnet" | "futurenet" | "public" | string;
  readonly networkPassphrase: string;
  readonly kernelContractId: string;
  readonly tokenContractId: string;
  readonly tokenDecimals: number;
  readonly hookContractId?: string;
  readonly hookReviewSeconds?: number;
  readonly explorerBaseUrl?: string;
  readonly identities: Readonly<Record<string, string>>;
  readonly commitSha?: string;
  readonly kernelWasmSha256?: string;
  readonly hookWasmSha256?: string;
}

export interface EvidenceTransaction {
  readonly label: string;
  readonly method: string;
  readonly hash: string;
  readonly explorerUrl?: string;
  readonly ledger: number;
  readonly createdAt: number;
  readonly closedAt: string;
  readonly fee: string;
  readonly minResourceFee: string;
  readonly resources: RelayReceipt<unknown>["resources"];
  readonly source: string;
  readonly contractId: string;
  readonly authorizers: readonly string[];
  readonly argumentsSha256: string;
  readonly envelopeSha256: string;
  readonly returnValueXdr?: string;
  readonly resultXdr?: string;
  readonly contractEventsXdr: readonly string[];
  readonly decodedEvents: RelayReceipt<unknown>["decodedEvents"];
  readonly balanceChanges: readonly EvidenceBalanceDelta[];
}

export interface EvidenceJobSnapshot {
  readonly label: string;
  readonly id: string;
  readonly state: Job["state"]["tag"];
  readonly client: string;
  readonly provider?: string;
  readonly evaluator: string;
  readonly descriptionSha256: string;
  readonly budget: string;
  readonly expiresAt: string;
  readonly hook?: string;
  readonly workHash?: string;
  readonly decision?: string;
}

export interface EvidenceBalanceDelta {
  readonly label: string;
  readonly address: string;
  readonly before: string;
  readonly after: string;
  readonly delta: string;
}

/**
 * Secret-safe raw capture produced by the demo.
 *
 * This is intentionally not the final release EvidenceManifest. Release
 * tooling combines this capture with deterministic build/deployment artifacts
 * and external publication attestations, then validates docs/evidence.schema.json.
 */
export interface RawEvidenceCapture {
  readonly schema: "stellar-8183/raw-testnet-capture/v1";
  readonly generatedAt: string;
  readonly network: {
    readonly name: string;
    readonly passphrase: string;
  };
  readonly contracts: {
    readonly kernel: string;
    readonly token: string;
    readonly hook?: string;
    readonly hookReviewSeconds?: number;
  };
  readonly token: {
    readonly contractId: string;
    readonly decimals: number;
  };
  readonly source: {
    readonly commitSha?: string;
    readonly kernelWasmSha256?: string;
    readonly hookWasmSha256?: string;
  };
  readonly identities: Readonly<Record<string, string>>;
  readonly transactions: readonly EvidenceTransaction[];
  readonly jobs: readonly EvidenceJobSnapshot[];
  readonly balances: readonly EvidenceBalanceDelta[];
}

function assertPublicAddress(address: string, label: string): void {
  try {
    Address.fromString(address);
  } catch (cause) {
    throw new TypeError(`${label} must be a public Stellar address`, { cause });
  }
}

function optionalHex(value: Uint8Array | undefined): string | undefined {
  return value === undefined ? undefined : commitmentToHex(value);
}

/**
 * Builds a whitelist-only evidence object.
 *
 * It never copies environment variables, signer objects, headers, seeds, or
 * arbitrary metadata, which keeps accidental secret disclosure out of demo
 * artifacts.
 */
export class EvidenceRecorder {
  private readonly transactions: EvidenceTransaction[] = [];
  private readonly jobs: EvidenceJobSnapshot[] = [];
  private readonly balances: EvidenceBalanceDelta[] = [];

  constructor(private readonly config: EvidenceConfig) {
    assertPublicAddress(config.kernelContractId, "kernelContractId");
    assertPublicAddress(config.tokenContractId, "tokenContractId");
    if (config.hookContractId !== undefined) {
      assertPublicAddress(config.hookContractId, "hookContractId");
      invariant(
        config.hookReviewSeconds !== undefined &&
          Number.isSafeInteger(config.hookReviewSeconds) &&
          config.hookReviewSeconds > 0,
        "INVALID_ARGUMENT",
        "hookReviewSeconds must be a positive integer when a hook is present",
      );
    } else {
      invariant(
        config.hookReviewSeconds === undefined,
        "INVALID_ARGUMENT",
        "hookReviewSeconds requires hookContractId",
      );
    }
    invariant(
      Number.isSafeInteger(config.tokenDecimals) &&
        config.tokenDecimals >= 0 &&
        config.tokenDecimals <= 255,
      "INVALID_ARGUMENT",
      "tokenDecimals must be an unsigned 8-bit integer",
    );
    for (const [role, address] of Object.entries(config.identities)) {
      assertPublicAddress(address, `identities.${role}`);
    }
  }

  recordTransaction<T>(
    label: string,
    receipt: RelayReceipt<T>,
    balanceChanges: readonly EvidenceBalanceDelta[] = [],
  ): void {
    invariant(
      label.length > 0,
      "INVALID_ARGUMENT",
      "evidence transaction label cannot be empty",
    );
    const explorerUrl =
      this.config.explorerBaseUrl === undefined
        ? undefined
        : `${this.config.explorerBaseUrl.replace(/\/$/, "")}/tx/${receipt.hash}`;
    this.transactions.push({
      label,
      method: receipt.method,
      hash: receipt.hash,
      explorerUrl,
      ledger: receipt.ledger,
      createdAt: receipt.createdAt,
      closedAt: receipt.closedAt,
      fee: receipt.fee,
      minResourceFee: receipt.minResourceFee,
      resources: receipt.resources,
      source: receipt.source,
      contractId: receipt.contractId,
      authorizers: [...receipt.authorizers],
      argumentsSha256: receipt.argumentsSha256,
      envelopeSha256: receipt.envelopeSha256,
      returnValueXdr: receipt.returnValueXdr,
      resultXdr: receipt.resultXdr,
      contractEventsXdr: [...receipt.contractEventsXdr],
      decodedEvents: receipt.decodedEvents.map((event) => ({
        contractId: event.contractId,
        name: event.name,
        decoded: { ...event.decoded },
      })),
      balanceChanges: balanceChanges.map((change) => ({ ...change })),
    });
  }

  /**
   * Structured hook for deployment/admission tooling that does not use the
   * kernel relay path. Extra runtime object properties are intentionally not
   * copied.
   */
  recordExternalTransaction(transaction: EvidenceTransaction): void {
    this.transactions.push({
      label: transaction.label,
      method: transaction.method,
      hash: transaction.hash,
      explorerUrl: transaction.explorerUrl,
      ledger: transaction.ledger,
      createdAt: transaction.createdAt,
      closedAt: transaction.closedAt,
      fee: transaction.fee,
      minResourceFee: transaction.minResourceFee,
      resources: { ...transaction.resources },
      source: transaction.source,
      contractId: transaction.contractId,
      authorizers: [...transaction.authorizers],
      argumentsSha256: transaction.argumentsSha256,
      envelopeSha256: transaction.envelopeSha256,
      returnValueXdr: transaction.returnValueXdr,
      resultXdr: transaction.resultXdr,
      contractEventsXdr: [...transaction.contractEventsXdr],
      decodedEvents: transaction.decodedEvents.map((event) => ({
        contractId: event.contractId,
        name: event.name,
        decoded: { ...event.decoded },
      })),
      balanceChanges: transaction.balanceChanges.map((change) => ({
        ...change,
      })),
    });
  }

  recordJob(label: string, job: Job): void {
    this.jobs.push({
      label,
      id: job.id.toString(),
      state: job.state.tag,
      client: job.client,
      provider: job.provider,
      evaluator: job.evaluator,
      descriptionSha256: hash(Buffer.from(job.desc, "utf8")).toString("hex"),
      budget: job.budget.toString(),
      expiresAt: job.expires_at.toString(),
      hook: job.hook,
      workHash: optionalHex(job.work_hash),
      decision: optionalHex(job.decision),
    });
  }

  recordBalance(
    label: string,
    address: string,
    before: bigint,
    after: bigint,
  ): void {
    assertPublicAddress(address, "balance address");
    this.balances.push({
      label,
      address,
      before: before.toString(),
      after: after.toString(),
      delta: (after - before).toString(),
    });
  }

  toCapture(now = new Date()): RawEvidenceCapture {
    return {
      schema: "stellar-8183/raw-testnet-capture/v1",
      generatedAt: now.toISOString(),
      network: {
        name: this.config.network,
        passphrase: this.config.networkPassphrase,
      },
      contracts: {
        kernel: this.config.kernelContractId,
        token: this.config.tokenContractId,
        hook: this.config.hookContractId,
        hookReviewSeconds: this.config.hookReviewSeconds,
      },
      token: {
        contractId: this.config.tokenContractId,
        decimals: this.config.tokenDecimals,
      },
      source: {
        commitSha: this.config.commitSha,
        kernelWasmSha256: this.config.kernelWasmSha256,
        hookWasmSha256: this.config.hookWasmSha256,
      },
      identities: { ...this.config.identities },
      transactions: [...this.transactions],
      jobs: [...this.jobs],
      balances: [...this.balances],
    };
  }

  toJSON(space = 2): string {
    return `${JSON.stringify(this.toCapture(), null, space)}\n`;
  }
}
