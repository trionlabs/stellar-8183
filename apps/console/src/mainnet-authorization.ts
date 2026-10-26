export interface MainnetAuthorization {
  schema: "stellar-8183/mainnet-authorization/v1";
  sourceCommit: string;
  kernelWasmSha256: string;
  hookWasmSha256: string;
  chapterLeadApproval: {
    approver: string;
    reference: string;
    approvedAt: string;
    valuelessCanaryAccepted: true;
  };
  independentAudit: {
    reviewer: string;
    reference: string;
    completedAt: string;
    independentFromBuilder: true;
    unresolvedCritical: 0;
    unresolvedHigh: 0;
  };
  threatModelReview: {
    approver: string;
    reference: string;
    approvedAt: string;
    approved: true;
  };
}

const exactKeys = (value: object, keys: string[], label: string): void => {
  if (Object.keys(value).sort().join() !== keys.sort().join())
    throw new Error(`${label} has unexpected or missing fields.`);
};

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
};

const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim().length < 3)
    throw new Error(`${label} must be a non-placeholder string.`);
  if (/^(todo|tbd|placeholder|none)$/i.test(value.trim()))
    throw new Error(`${label} cannot be a placeholder.`);
  return value;
};

const timestamp = (value: unknown, label: string): string => {
  const result = text(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(result))
    throw new Error(`${label} must be an ISO-8601 UTC timestamp.`);
  if (Date.parse(result) > Date.now())
    throw new Error(`${label} cannot be in the future.`);
  return result;
};

const hash = (value: unknown, length: 40 | 64, label: string): string => {
  if (
    typeof value !== "string" ||
    !new RegExp(`^[a-f0-9]{${length}}$`).test(value)
  )
    throw new Error(
      `${label} must be a ${length}-character lowercase hex value.`,
    );
  return value;
};

export function parseMainnetAuthorization(input: string): MainnetAuthorization {
  if (input.length > 64_000)
    throw new Error("Authorization record is too large.");
  const value = record(JSON.parse(input) as unknown, "Authorization record");
  exactKeys(
    value,
    [
      "schema",
      "sourceCommit",
      "kernelWasmSha256",
      "hookWasmSha256",
      "chapterLeadApproval",
      "independentAudit",
      "threatModelReview",
    ],
    "Authorization record",
  );
  if (value.schema !== "stellar-8183/mainnet-authorization/v1")
    throw new Error("Unsupported Mainnet authorization schema.");
  const chapter = record(value.chapterLeadApproval, "Chapter Lead approval");
  exactKeys(
    chapter,
    ["approver", "reference", "approvedAt", "valuelessCanaryAccepted"],
    "Chapter Lead approval",
  );
  const audit = record(value.independentAudit, "Independent audit");
  exactKeys(
    audit,
    [
      "reviewer",
      "reference",
      "completedAt",
      "independentFromBuilder",
      "unresolvedCritical",
      "unresolvedHigh",
    ],
    "Independent audit",
  );
  const threat = record(value.threatModelReview, "Threat-model review");
  exactKeys(
    threat,
    ["approver", "reference", "approvedAt", "approved"],
    "Threat-model review",
  );
  if (chapter.valuelessCanaryAccepted !== true)
    throw new Error("Chapter Lead must accept the valueless canary boundary.");
  if (
    audit.independentFromBuilder !== true ||
    audit.unresolvedCritical !== 0 ||
    audit.unresolvedHigh !== 0
  )
    throw new Error(
      "Independent audit must have zero unresolved critical and high findings.",
    );
  if (threat.approved !== true)
    throw new Error("Threat-model review must be explicitly approved.");
  return {
    schema: value.schema,
    sourceCommit: hash(value.sourceCommit, 40, "Source commit"),
    kernelWasmSha256: hash(value.kernelWasmSha256, 64, "Kernel Wasm hash"),
    hookWasmSha256: hash(value.hookWasmSha256, 64, "Hook Wasm hash"),
    chapterLeadApproval: {
      approver: text(chapter.approver, "Chapter Lead approver"),
      reference: text(chapter.reference, "Chapter Lead approval reference"),
      approvedAt: timestamp(chapter.approvedAt, "Chapter Lead approval time"),
      valuelessCanaryAccepted: true,
    },
    independentAudit: {
      reviewer: text(audit.reviewer, "Independent reviewer"),
      reference: text(audit.reference, "Independent audit reference"),
      completedAt: timestamp(audit.completedAt, "Independent audit time"),
      independentFromBuilder: true,
      unresolvedCritical: 0,
      unresolvedHigh: 0,
    },
    threatModelReview: {
      approver: text(threat.approver, "Threat-model approver"),
      reference: text(threat.reference, "Threat-model review reference"),
      approvedAt: timestamp(threat.approvedAt, "Threat-model approval time"),
      approved: true,
    },
  };
}

export function assertNoSecretEnvironment(
  environment: NodeJS.ProcessEnv,
): void {
  for (const key of [
    "STELLAR_ACCOUNT",
    "STELLAR_SIGN_WITH_KEY",
    "STELLAR_SECRET_KEY",
    "MAINNET_PRIVATE_KEY",
    "MAINNET_SEED_PHRASE",
  ]) {
    const value = environment[key];
    if (value?.trim())
      throw new Error(
        `${key} must not carry signing material. Use a named OS secure-store or hardware-wallet identity.`,
      );
  }
}
