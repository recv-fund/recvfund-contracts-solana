#!/usr/bin/env python3
"""Package a candidate without promoting it to public deployment provenance."""
import hashlib
import json
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'security/artifacts/candidate'
IMAGE = 'solanafoundation/solana-verifiable-build@sha256:c78fd4ff5399ee5ea3e154881e8991bd8064899ca162a59cafc682da5a5bd516'


def validate_receipt(receipt, commit, binary):
    expected = {'sourceCommit': commit, 'image': IMAGE,
                'sha256': hashlib.sha256(binary).hexdigest(), 'byteLength': len(binary)}
    if receipt != expected:
        raise ValueError('Missing or stale verified-build receipt; run scripts/verified-build.sh')


def main():
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    if subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=ROOT):
        raise ValueError('Release artifacts require a clean tracked checkout')
    receipt_path = ROOT / 'security/artifacts/verified-build-receipt.json'
    receipt = json.loads(receipt_path.read_text()) if receipt_path.exists() else None
    validate_receipt(receipt, commit, (ROOT / 'target/deploy/recvfund.so').read_bytes())
    DEST.mkdir(parents=True, exist_ok=True)
    files = {}
    for source in ['target/deploy/recvfund.so', 'target/idl/recvfund.json', 'target/types/recvfund.ts']:
        p = ROOT / source
        data = p.read_bytes()
        shutil.copyfile(p, DEST / p.name)
        files[p.name] = {'sha256': hashlib.sha256(data).hexdigest(), 'byteLength': len(data)}
    idl = json.loads((DEST / 'recvfund.json').read_text())
    manifest = {
        'schemaVersion': 1, 'status': 'candidate', 'deployed': False,
        'source': {'repository': 'https://github.com/recv-fund/recvfund-contracts-solana', 'commit': commit},
        'programId': idl['address'], 'files': files,
        'toolchain': {'agave': '2.1.21', 'platformTools': 'v1.43', 'sbfRust': '1.79.0',
                      'hostRust': '1.85.1', 'anchorCli': '0.31.1', 'solanaVerify': '0.5.2', 'image': IMAGE},
        'cargoLockSha256': hashlib.sha256((ROOT / 'Cargo.lock').read_bytes()).hexdigest(),
        'promotion': 'Requires authorized deployment, on-chain byte equality, authority verification and funded devnet acceptance; never replace server public pins from this candidate alone.',
    }
    (DEST / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps(manifest, indent=2))


if __name__ == '__main__':
    main()
