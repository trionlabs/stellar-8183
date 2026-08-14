.PHONY: all build check clean contracts format release sdk test verify-release

all: check build

build: contracts sdk

check:
	cargo fmt --all -- --check
	cargo clippy --workspace --all-targets --all-features -- -D warnings
	cargo test --workspace --all-features
	./scripts/release-build.sh
	pnpm bindings:check
	pnpm check

clean:
	cargo clean
	pnpm clean

contracts:
	stellar contract build --locked --optimize

format:
	cargo fmt --all
	pnpm format

release:
	./scripts/release-build.sh

sdk:
	pnpm build

test:
	cargo test --workspace --all-features
	pnpm test

verify-release:
	./scripts/verify-release.sh
