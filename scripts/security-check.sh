#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

for tool in cargo anchor solana-test-validator solana-keygen yarn; do
  command -v "$tool" >/dev/null
done
mkdir -p security/artifacts
cargo --version > security/artifacts/toolchain.txt
rustc --version >> security/artifacts/toolchain.txt
anchor --version >> security/artifacts/toolchain.txt
solana-test-validator --version >> security/artifacts/toolchain.txt
cargo fmt --all -- --check
cargo test --locked -p recvfund --lib | tee security/artifacts/cargo-test.txt
cargo clippy --locked --all-targets -- -D warnings
python3 -m unittest discover -s scripts/tests
python3 scripts/check-dependencies.py
yarn install --frozen-lockfile
yarn lint
if [[ "${RECVFUND_VERIFIED_BUILD:-0}" == "1" ]]; then
  bash scripts/verified-build.sh
else
  bash scripts/build.sh
fi
yarn tsc --noEmit
# Test only a local validator, with a throwaway signer. Never use a merchant key.
wallet_dir=$(mktemp -d)
trap 'rm -rf "$wallet_dir"' EXIT
solana-keygen new --silent --no-bip39-passphrase -o "$wallet_dir/wallet.json" >/dev/null
anchor test --skip-build --provider.cluster localnet \
  --provider.wallet "$wallet_dir/wallet.json" | tee security/artifacts/anchor-test.txt
echo "Local checks passed. Review audit warnings and obtain an external audit before mainnet."
