#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(solana-verify --version)" == 'solana-verify 0.5.2' ]]
image=solanafoundation/solana-verifiable-build@sha256:c78fd4ff5399ee5ea3e154881e8991bd8064899ca162a59cafc682da5a5bd516
mkdir -p security/artifacts
# Fixed Docker workdir and image digest prevent host paths/toolchains affecting SBF.
solana-verify build --library-name recvfund --base-image "$image" \
  | tee security/artifacts/verified-build.txt
# IDL is compiled from the same locked source using the official builder.
cargo run --locked -p recvfund-idl-builder
mkdir -p target/types
anchor idl type target/idl/recvfund.json -o target/types/recvfund.ts
python3 scripts/release-manifest.py
