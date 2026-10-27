import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const sha256 = (path) =>
  createHash("sha256")
    .update(readFileSync(join(root, path)))
    .digest("hex");
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
};

test("grant index authenticates the published Testnet and Mainnet JSON", () => {
  const index = read("deployments/month-two/grant-evidence-index.json");
  const testnet = read(index.testnetEngineeringDemo.evidencePath);
  const mainnet = read(index.mainnetCanary.evidencePath);
  const pilot = read(index.independentPilot.evidencePath);

  assert.equal(
    sha256(index.testnetEngineeringDemo.evidencePath),
    index.testnetEngineeringDemo.evidenceSha256,
  );
  assert.equal(
    sha256(index.mainnetCanary.evidencePath),
    index.mainnetCanary.evidenceSha256,
  );
  assert.equal(
    sha256(index.mainnetCanary.transactionArchivePath),
    index.mainnetCanary.transactionArchiveSha256,
  );
  assert.equal(
    sha256(index.independentPilot.evidencePath),
    index.independentPilot.evidenceSha256,
  );
  assert.equal(testnet.independentParticipant, false);
  assert.equal(mainnet.independentParticipant, false);
  assert.equal(mainnet.profile.id, "mainnet-canary");
  assert.equal(index.independentPilot.independentParticipant, true);
  assert.equal(
    index.independentPilot.status,
    "proxy-transaction-paths-complete",
  );
  assert.equal(pilot.publicParticipantName, null);
  assert.equal(pilot.executionMode, "coordinator-approved-proxy");
  assert.equal(pilot.participantPersonallySignedTransactions, false);
});

test("independent pilot JSON discloses proxy custody and verifies six receipts", () => {
  const evidence = read(
    "deployments/month-two/independent-pilot-evidence.json",
  );
  assert.equal(evidence.independentParticipant, true);
  assert.equal(evidence.unaffiliatedWithTrionLabs, true);
  assert.equal(evidence.keyCustody.generatedByProjectOperator, true);
  assert.equal(evidence.keyCustody.secretPublished, false);
  assert.equal(evidence.scenarios.length, 6);
  assert.deepEqual(
    evidence.scenarios.map(({ path, receipt }) => [
      path,
      receipt.receipt.state,
      receipt.receipt.terminalTransaction.method,
    ]),
    [
      ["completion", "Completed", "complete"],
      ["funded-rejection", "Rejected", "reject"],
      ["expired-refund", "Expired", "claim_refund"],
      ["completion", "Completed", "complete"],
      ["funded-rejection", "Rejected", "reject"],
      ["expired-refund", "Expired", "claim_refund"],
    ],
  );

  for (const scenario of evidence.scenarios) {
    assert.equal(scenario.balanceAccounting.terminal.escrow, "0");
    assert.equal(scenario.jobId, scenario.receipt.receipt.jobId);
    assert.equal(
      createHash("sha256")
        .update(canonical(scenario.receipt.receipt))
        .digest("hex"),
      scenario.receipt.sha256,
    );
    assert.ok(
      evidence.explorerLinks.jobs[scenario.jobId].endsWith(
        scenario.receipt.receipt.terminalTransaction.hash,
      ),
    );
  }
});

test("Testnet demo receipts cover each terminal path without a pilot claim", () => {
  const evidence = read("deployments/month-two/testnet-demo-evidence.json");
  assert.equal(evidence.schema, "stellar-8183/grant-testnet-demo/v1");
  assert.equal(evidence.evidenceType, "author-run");
  assert.equal(evidence.independentParticipant, false);
  assert.equal(evidence.video.publicUrl, null);
  assert.deepEqual(
    evidence.jobs.map(({ receipt }) => [
      receipt.state,
      receipt.terminalTransaction.method,
    ]),
    [
      ["Completed", "complete"],
      ["Rejected", "reject"],
      ["Expired", "claim_refund"],
    ],
  );
  assert.equal(new Set(evidence.jobs.map(({ jobId }) => jobId)).size, 3);

  for (const job of evidence.jobs) {
    assert.equal(job.jobId, job.receipt.jobId);
    assert.ok(job.explorerUrl.endsWith(job.receipt.terminalTransaction.hash));
    assert.equal(
      createHash("sha256").update(canonical(job.receipt)).digest("hex"),
      job.receiptSha256,
    );
  }
});
