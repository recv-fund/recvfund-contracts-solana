#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(solana-verify --version)" == 'solana-verify 0.5.2' ]]
image=solanafoundation/solana-verifiable-build@sha256:c78fd4ff5399ee5ea3e154881e8991bd8064899ca162a59cafc682da5a5bd516
mkdir -p security/artifacts
# Reject dirty inputs and stale output before the build; receipts bind exact bytes.
test -z "$(git status --porcelain --untracked-files=no)"
python3 -c 'from pathlib import Path; Path("target/deploy/recvfund.so").unlink(missing_ok=True); Path("security/artifacts/verified-build-receipt.json").unlink(missing_ok=True)'
# Fixed Docker workdir and image digest prevent host paths/toolchains affecting SBF.
solana-verify build --library-name recvfund --base-image "$image" \
  | tee security/artifacts/verified-build.txt
python3 - <<'PYRECEIPT'
import hashlib, json, subprocess
from pathlib import Path
binary = Path('target/deploy/recvfund.so').read_bytes()
receipt = {'sourceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
           'image': 'solanafoundation/solana-verifiable-build@sha256:c78fd4ff5399ee5ea3e154881e8991bd8064899ca162a59cafc682da5a5bd516',
           'sha256': hashlib.sha256(binary).hexdigest(), 'byteLength': len(binary)}
Path('security/artifacts/verified-build-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
PYRECEIPT
# IDL is compiled from the same locked source using the official builder.
cargo run --locked -p recvfund-idl-builder
mkdir -p target/types
anchor idl type target/idl/recvfund.json -o target/types/recvfund.ts
python3 scripts/release-manifest.py
