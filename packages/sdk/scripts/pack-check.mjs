import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "stellar-8183-pack-"));

function fail(message) {
  throw new Error(`pack check failed: ${message}`);
}

try {
  const packOutput = execFileSync(
    "npm",
    ["pack", "--json", "--pack-destination", temporaryRoot],
    {
      cwd: packageRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const packResult = JSON.parse(packOutput)[0];
  if (!packResult?.filename || !Array.isArray(packResult.files)) {
    fail("npm pack did not return a file manifest");
  }
  const packedFiles = new Set(packResult.files.map(({ path }) => path));
  for (const required of [
    "package.json",
    "LICENSE",
    "README.md",
    "dist/index.js",
    "dist/index.d.ts",
  ]) {
    if (!packedFiles.has(required)) {
      fail(`tarball is missing ${required}`);
    }
  }
  if (
    [...packedFiles].some(
      (path) =>
        path.startsWith("src/") ||
        path.startsWith("test/") ||
        path.includes(".env"),
    )
  ) {
    fail("tarball contains source, tests, or environment files");
  }

  const consumer = join(temporaryRoot, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  const tarball = join(temporaryRoot, packResult.filename);
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      tarball,
    ],
    { cwd: consumer, stdio: "inherit" },
  );

  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        'import("@trionlabs/stellar-8183").then((sdk) => {',
        '  if (sdk.parseUnits("1") !== 10000000n) throw new Error("bad runtime export");',
        '  if (typeof sdk.AgenticCommerce !== "function") throw new Error("missing client export");',
        "});",
      ].join("\n"),
    ],
    { cwd: consumer, stdio: "inherit" },
  );

  const typeFixture = join(consumer, "consumer.ts");
  writeFileSync(
    typeFixture,
    [
      'import { AgenticCommerce, parseUnits, type RelayIntent } from "@trionlabs/stellar-8183";',
      "const amount: bigint = parseUnits('1');",
      "const clientType: typeof AgenticCommerce = AgenticCommerce;",
      "const intent: RelayIntent | undefined = undefined;",
      "void amount; void clientType; void intent;",
    ].join("\n"),
  );
  const program = ts.createProgram([typeFixture], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2023,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    const rendered = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => consumer,
      getNewLine: () => "\n",
    });
    process.stderr.write(rendered);
    fail("packed declaration files failed clean-consumer typecheck");
  }

  const packedPackage = JSON.parse(
    readFileSync(
      join(consumer, "node_modules/@trionlabs/stellar-8183/package.json"),
    ),
  );
  if (packedPackage.version !== "0.1.0") {
    fail("installed tarball has the wrong version");
  }
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}
