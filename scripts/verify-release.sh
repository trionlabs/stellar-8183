#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
first_dir="$(mktemp -d)"
second_dir="$(mktemp -d)"

cleanup() {
  rm -rf "${first_dir}" "${second_dir}"
}
trap cleanup EXIT

build_once() {
  local output_dir="$1"
  CARGO_TARGET_DIR="${output_dir}/target" \
    stellar contract build \
      --locked \
      --optimize \
      --package stellar-8183-commerce \
      --out-dir "${output_dir}" \
      --meta source_repo=github:trionlabs/stellar-8183
  CARGO_TARGET_DIR="${output_dir}/target" \
    stellar contract build \
      --locked \
      --optimize \
      --package stellar-8183-sla-hook \
      --out-dir "${output_dir}" \
      --meta source_repo=github:trionlabs/stellar-8183
}

build_once "${first_dir}"
build_once "${second_dir}"

for wasm_name in stellar_8183_commerce.wasm stellar_8183_sla_hook.wasm; do
  cmp "${first_dir}/${wasm_name}" "${second_dir}/${wasm_name}"
  shasum -a 256 "${first_dir}/${wasm_name}"
done

echo "Deterministic release build verified."
