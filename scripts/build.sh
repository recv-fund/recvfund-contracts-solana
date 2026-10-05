#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# The Anchor 0.31.1 CLI's bundled IDL builder injects an obsolete proc-macro
# flag. Use the locked upstream IdlBuilder crate; SBF code is built normally.
cargo build-sbf --manifest-path programs/recvfund/Cargo.toml -- --locked
cargo run --locked -p recvfund-idl-builder
mkdir -p target/types
anchor idl type target/idl/recvfund.json -o target/types/recvfund.ts
