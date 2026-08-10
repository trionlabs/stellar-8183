export type SdkErrorCode =
  | "CONTRACT_ERROR"
  | "INVALID_ARGUMENT"
  | "INVALID_AMOUNT"
  | "INVALID_COMMITMENT"
  | "INVALID_RELAY_INTENT"
  | "RELAY_AUTHORIZATION_MISMATCH"
  | "RELAY_ENVELOPE_MISMATCH"
  | "RELAY_EXPIRED"
  | "RELAY_FEE_EXCEEDED"
  | "RELAY_RESTORATION_REQUIRED"
  | "RELAY_SIMULATION_FAILED"
  | "RELAY_SUBMISSION_FAILED"
  | "RELAY_TIMEOUT"
  | "RESTORATION_POLICY_MISMATCH"
  | "SIGNER_MISMATCH"
  | "UNSUPPORTED_TRANSACTION";

/**
 * An error with a stable, machine-readable code.
 *
 * Contract errors remain the generated client's responsibility; this class
 * covers SDK-side validation and transport failures.
 */
export class AgenticCommerceError extends Error {
  readonly code: SdkErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: SdkErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgenticCommerceError";
    this.code = code;
    this.details = details;
  }
}

export function invariant(
  condition: unknown,
  code: SdkErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): asserts condition {
  if (!condition) {
    throw new AgenticCommerceError(code, message, details);
  }
}
