import {
  BASE_FEE,
  Transaction,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";

import { AgenticCommerceError } from "../errors.js";
import type {
  EnforcedSimulation,
  RelayRpc,
  RelaySubmission,
  RelayTransactionResult,
} from "./types.js";

function normalizeCreatedAt(value: unknown): number {
  const normalized =
    typeof value === "string" && /^[1-9]\d*$/.test(value)
      ? Number(value)
      : value;
  if (
    typeof normalized !== "number" ||
    !Number.isSafeInteger(normalized) ||
    normalized <= 0
  ) {
    throw new AgenticCommerceError(
      "RELAY_SUBMISSION_FAILED",
      "RPC returned an invalid transaction close timestamp",
      { createdAt: String(value) },
    );
  }
  return normalized;
}

export interface StellarRelayRpcOptions {
  readonly allowHttp?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Production RPC transport. Tests can inject the smaller RelayRpc interface. */
export class StellarRelayRpc implements RelayRpc {
  readonly server: rpc.Server;

  constructor(rpcUrl: string, options: StellarRelayRpcOptions = {}) {
    this.server = new rpc.Server(rpcUrl, {
      allowHttp: options.allowHttp,
      headers: options.headers,
    });
  }

  async getLatestLedger(): Promise<number> {
    return (await this.server.getLatestLedger()).sequence;
  }

  /** Return the network passphrase advertised by the configured RPC endpoint. */
  async getNetworkPassphrase(): Promise<string> {
    return (await this.server.getNetwork()).passphrase;
  }

  /** Returns the authoritative Unix close time reported by the latest ledger. */
  async getLatestLedgerCloseTime(): Promise<number> {
    const closeTime = (await this.server.getLatestLedger()).closeTime;
    if (!/^\d+$/.test(closeTime)) {
      throw new AgenticCommerceError(
        "RELAY_SIMULATION_FAILED",
        "RPC returned an invalid latest-ledger close time",
        { closeTime },
      );
    }
    const parsed = Number(closeTime);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new AgenticCommerceError(
        "RELAY_SIMULATION_FAILED",
        "RPC latest-ledger close time is outside the safe integer range",
        { closeTime },
      );
    }
    return parsed;
  }

  async refresh(
    transaction: Transaction,
    timeoutInSeconds: number,
  ): Promise<Transaction> {
    const source = await this.server.getAccount(transaction.source);
    const rawOperations = transaction.tx.operations();
    if (rawOperations.length !== 1) {
      throw new AgenticCommerceError(
        "RELAY_ENVELOPE_MISMATCH",
        "cannot refresh a transaction that does not contain exactly one operation",
      );
    }
    return new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: transaction.networkPassphrase,
    })
      .setTimeout(timeoutInSeconds)
      .addOperation(rawOperations[0]!)
      .build();
  }

  async enforce(transaction: Transaction): Promise<EnforcedSimulation> {
    const simulation = await this.server.simulateTransaction(
      transaction,
      undefined,
      "enforce",
    );
    if (rpc.Api.isSimulationRestore(simulation)) {
      throw new AgenticCommerceError(
        "RELAY_RESTORATION_REQUIRED",
        "archived state must be restored before preparing fresh authorizations",
        {
          latestLedger: simulation.latestLedger,
          minResourceFee: simulation.restorePreamble.minResourceFee,
        },
      );
    }
    if (!rpc.Api.isSimulationSuccess(simulation)) {
      throw new AgenticCommerceError(
        "RELAY_SIMULATION_FAILED",
        "enforcing simulation rejected the signed authorization entries",
        {
          latestLedger: simulation.latestLedger,
          error: simulation.error,
        },
      );
    }
    const assembled = rpc.assembleTransaction(transaction, simulation).build();
    if (!(assembled instanceof Transaction)) {
      throw new AgenticCommerceError(
        "UNSUPPORTED_TRANSACTION",
        "enforcing simulation produced a fee-bump transaction",
      );
    }
    return {
      transaction: assembled,
      latestLedger: simulation.latestLedger,
      minResourceFee: simulation.minResourceFee,
    };
  }

  async submit(transaction: Transaction): Promise<RelaySubmission> {
    const response = await this.server.sendTransaction(transaction);
    return {
      hash: response.hash,
      status: response.status,
      errorResultXdr: response.errorResult?.toXDR("base64"),
    };
  }

  async getTransaction(hash: string): Promise<RelayTransactionResult> {
    const response = await this.server.getTransaction(hash);
    if (response.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
      return {
        status: "NOT_FOUND",
        hash,
        latestLedger: response.latestLedger,
      };
    }

    const contractEventsXdr = response.events.contractEventsXdr
      .flat()
      .map((event) => event.toXDR("base64"));
    const diagnosticEventsXdr =
      response.diagnosticEventsXdr?.map((event) => event.toXDR("base64")) ?? [];
    return {
      status:
        response.status === rpc.Api.GetTransactionStatus.SUCCESS
          ? "SUCCESS"
          : "FAILED",
      hash: response.txHash,
      latestLedger: response.latestLedger,
      ledger: response.ledger,
      createdAt: normalizeCreatedAt(response.createdAt),
      resultXdr: response.resultXdr.toXDR("base64"),
      returnValue:
        response.status === rpc.Api.GetTransactionStatus.SUCCESS
          ? response.returnValue
          : undefined,
      contractEventsXdr,
      diagnosticEventsXdr,
    };
  }
}
