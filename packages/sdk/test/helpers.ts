import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  Transaction,
  TransactionBuilder,
  authorizeEntry,
  inspectAuthEntry,
  xdr,
} from "@stellar/stellar-sdk";
import type { AssembledTransaction } from "@stellar/stellar-sdk/contract";

import type {
  KernelAdapter,
  KernelMethod,
  PreparedInvocation,
} from "../src/kernel-types.js";
import type {
  RelayAuthorizationRequirement,
  RelayIntent,
} from "../src/relay/types.js";
import {
  inspectInvocation,
  inspectSorobanFootprint,
} from "../src/relay/validation.js";

export const CURRENT_TIME = 1_900_000_000;
export const CURRENT_LEDGER = 900;
export const AUTH_EXPIRATION = 1_000;
export const NETWORK = Networks.TESTNET;

export interface RelayFixture {
  readonly facilitator: Keypair;
  readonly role: Keypair;
  readonly contractId: string;
  readonly invocation: xdr.SorobanAuthorizedInvocation;
  readonly transaction: Transaction;
}

export function contractAddress(byte = 1): string {
  return Address.contract(Buffer.alloc(32, byte)).toString();
}

function invocationFor(
  contractId: string,
  method: string,
): {
  invocation: xdr.SorobanAuthorizedInvocation;
  invokeArgs: xdr.InvokeContractArgs;
} {
  const invokeArgs = new xdr.InvokeContractArgs({
    contractAddress: Address.fromString(contractId).toScAddress(),
    functionName: method,
    args: [xdr.ScVal.scvU64(xdr.Uint64.fromString("7"))],
  });
  return {
    invokeArgs,
    invocation: new xdr.SorobanAuthorizedInvocation({
      function:
        xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          invokeArgs,
        ),
      subInvocations: [],
    }),
  };
}

export async function relayFixture(
  options: {
    readonly signed?: boolean;
    readonly method?: string;
    readonly fee?: string;
    readonly maxTime?: number;
  } = {},
): Promise<RelayFixture> {
  const facilitator = Keypair.random();
  const role = Keypair.random();
  const contractId = contractAddress();
  const { invocation, invokeArgs } = invocationFor(
    contractId,
    options.method ?? "submit",
  );
  const credentials = new xdr.SorobanAddressCredentials({
    address: Address.fromString(role.publicKey()).toScAddress(),
    nonce: xdr.Int64.fromString("7"),
    signatureExpirationLedger: 0,
    signature: xdr.ScVal.scvVoid(),
  });
  let entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(credentials),
    rootInvocation: invocation,
  });
  if (options.signed === true) {
    entry = await authorizeEntry(entry, role, AUTH_EXPIRATION, NETWORK);
  }
  const operation = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(invokeArgs),
    auth: [entry],
  });
  const transaction = new TransactionBuilder(
    new Account(facilitator.publicKey(), "1"),
    { fee: options.fee ?? "100", networkPassphrase: NETWORK },
  )
    .setSorobanData(
      new SorobanDataBuilder()
        .setResources(100_000, 1_000, 1_000)
        .setResourceFee("0")
        .build(),
    )
    .setTimebounds(0, options.maxTime ?? CURRENT_TIME + 300)
    .addOperation(operation)
    .build();
  return { facilitator, role, contractId, invocation, transaction };
}

export function relayIntent(
  fixture: RelayFixture,
  maxFee = "1000",
): RelayIntent {
  const inspected = inspectInvocation(fixture.transaction);
  const authorizations: RelayAuthorizationRequirement[] = inspected.auth.map(
    (entry) => {
      const info = inspectAuthEntry(entry);
      if (
        info.address === null ||
        info.nonce === null ||
        info.credentialType === "sourceAccount"
      ) {
        throw new Error("test fixture has invalid credentials");
      }
      return {
        address: info.address,
        credentialType: info.credentialType,
        nonce: info.nonce.toString(),
        invocationXdr: info.invocation.toXDR("base64"),
      };
    },
  );
  return {
    version: 1,
    networkPassphrase: NETWORK,
    contractId: fixture.contractId,
    method: inspected.method as KernelMethod,
    argumentXdr: inspected.argumentXdr,
    facilitator: fixture.facilitator.publicKey(),
    sequence: fixture.transaction.sequence,
    minTime: fixture.transaction.timeBounds!.minTime,
    maxTime: fixture.transaction.timeBounds!.maxTime,
    maxFee,
    transactionTimeoutSeconds: 300,
    minSubmissionLifetimeSeconds: 15,
    authExpirationLedger: AUTH_EXPIRATION,
    authSubmitLedgerMargin: 3,
    footprint: inspectSorobanFootprint(fixture.transaction),
    authorizations,
  };
}

export function replaceAuthorizationRoot(
  fixture: RelayFixture,
  invokeArgs: xdr.InvokeContractArgs,
  subInvocations: readonly xdr.SorobanAuthorizedInvocation[] = [],
): RelayFixture {
  const originalOperation = fixture.transaction.operations[0]!;
  if (originalOperation.type !== "invokeHostFunction") {
    throw new Error("test fixture operation is not invokeHostFunction");
  }
  const originalEntry = originalOperation.auth?.[0];
  if (originalEntry === undefined) {
    throw new Error("test fixture has no authorization entry");
  }
  const rootInvocation = new xdr.SorobanAuthorizedInvocation({
    function:
      xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        invokeArgs,
      ),
    subInvocations: [...subInvocations],
  });
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: originalEntry.credentials(),
    rootInvocation,
  });
  const operation = Operation.invokeHostFunction({
    func: originalOperation.func,
    auth: [entry],
  });
  const sequenceBeforeBuild = (
    BigInt(fixture.transaction.sequence) - 1n
  ).toString();
  const transaction = new TransactionBuilder(
    new Account(fixture.facilitator.publicKey(), sequenceBeforeBuild),
    { fee: "100", networkPassphrase: NETWORK },
  )
    .setSorobanData(
      new SorobanDataBuilder()
        .setResources(100_000, 1_000, 1_000)
        .setResourceFee("0")
        .build(),
    )
    .setTimebounds(
      Number(fixture.transaction.timeBounds!.minTime),
      Number(fixture.transaction.timeBounds!.maxTime),
    )
    .addOperation(operation)
    .build();
  return { ...fixture, invocation: rootInvocation, transaction };
}

export function fakePrepared<T>(
  method: KernelMethod,
  transaction: Transaction,
  json = "serialized",
): PreparedInvocation<T> {
  return {
    method,
    transaction: {
      built: transaction,
      simulation: { latestLedger: CURRENT_LEDGER },
      toJSON: () => json,
    } as unknown as AssembledTransaction<T>,
  };
}

export function fakeAdapter<T>(
  prepared: PreparedInvocation<T>,
  decoded?: T,
): KernelAdapter {
  return {
    contractId: contractAddress(),
    networkPassphrase: NETWORK,
    rpcUrl: "https://rpc.test.invalid",
    invoke: async <R>() => prepared as unknown as PreparedInvocation<R>,
    deserialize: <R>() => prepared as unknown as PreparedInvocation<R>,
    decodeResult: <R>() => decoded as unknown as R,
  };
}
