#!/usr/bin/env bash
set -euo pipefail

package_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project_root="$(cd "${package_root}/../.." && pwd)"
wasm="${project_root}/artifacts/release/stellar_8183_commerce.wasm"
checked_in="${package_root}/src/generated/kernel.ts"
mode="${1:-write}"

if [[ "${mode}" != "write" && "${mode}" != "--check" ]]; then
  echo "usage: $0 [--check]" >&2
  exit 2
fi

stellar_version="$(stellar --version | awk 'NR == 1 {print $2}')"
if [[ "${stellar_version}" != "27.0.0" ]]; then
  echo "stellar-cli 27.0.0 is required; found ${stellar_version}" >&2
  exit 1
fi
if [[ ! -f "${wasm}" ]]; then
  echo "missing optimized commerce Wasm: ${wasm}" >&2
  echo "run scripts/release-build.sh first" >&2
  exit 1
fi

temporary_root="$(mktemp -d)"
cleanup() {
  rm -rf "${temporary_root}"
}
trap cleanup EXIT

stellar contract bindings typescript \
  --wasm "${wasm}" \
  --output-dir "${temporary_root}/kernel" \
  --overwrite \
  >/dev/null
generated="${temporary_root}/kernel/src/index.ts"

# CLI 27 emits valid default TypeScript, but this repository deliberately
# enables noImplicitOverride. Apply the two syntax-only modifiers required by
# that stricter setting before comparing or checking in the generated file.
perl -pi -e \
  's/^  static async deploy<T = Client>\(/  static override async deploy<T = Client>(/' \
  "${generated}"
perl -pi -e \
  's/^  constructor\(public readonly options:/  constructor(public override readonly options:/' \
  "${generated}"
grep -F "static override async deploy<T = Client>(" "${generated}" >/dev/null
grep -F "constructor(public override readonly options:" "${generated}" >/dev/null
if [[ -n "$(tail -c 1 "${generated}")" ]]; then
  printf '\n' >>"${generated}"
fi

if [[ "${mode}" == "--check" ]]; then
  if [[ ! -f "${checked_in}" ]] || ! cmp -s "${generated}" "${checked_in}"; then
    echo "checked-in TypeScript binding does not match optimized commerce Wasm" >&2
    echo "run: pnpm --filter @trionlabs/stellar-8183 bindings:generate" >&2
    if [[ -f "${checked_in}" ]]; then
      diff -u "${checked_in}" "${generated}" || true
    fi
    exit 1
  fi
  echo "TypeScript binding matches optimized commerce Wasm."
  exit 0
fi

mkdir -p "$(dirname "${checked_in}")"
cp "${generated}" "${checked_in}"
echo "Generated ${checked_in}"
