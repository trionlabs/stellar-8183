#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
release_dir="${project_root}/artifacts/release"
source_repo="${SOURCE_REPO:-github:trionlabs/stellar-8183}"

stellar_version="$(stellar --version | awk 'NR == 1 {print $2}')"
if [[ "${stellar_version}" != "27.0.0" ]]; then
  echo "stellar-cli 27.0.0 is required; found ${stellar_version}" >&2
  exit 1
fi

mkdir -p "${release_dir}"

stellar contract build \
  --locked \
  --optimize \
  --package stellar-8183-commerce \
  --out-dir "${release_dir}" \
  --meta "source_repo=${source_repo}"

stellar contract build \
  --locked \
  --optimize \
  --package stellar-8183-sla-hook \
  --out-dir "${release_dir}" \
  --meta "source_repo=${source_repo}"

for wasm_name in stellar_8183_commerce.wasm stellar_8183_sla_hook.wasm; do
  wasm_file="${release_dir}/${wasm_name}"
  if [[ ! -f "${wasm_file}" ]]; then
    echo "missing expected release artifact: ${wasm_file}" >&2
    exit 1
  fi

  byte_size="$(wc -c < "${wasm_file}" | tr -d ' ')"
  if (( byte_size > 131072 )); then
    echo "${wasm_file} exceeds the 128 KiB contract limit (${byte_size} bytes)" >&2
    exit 1
  fi
  shasum -a 256 "${wasm_file}"
  stellar contract info interface --wasm "${wasm_file}" >/dev/null
  stellar contract info meta --wasm "${wasm_file}" |
    grep -F "source_repo: ${source_repo}" >/dev/null
done
