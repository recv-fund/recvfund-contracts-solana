#!/usr/bin/env bash
set -euo pipefail
[[ "$(uname -s)-$(uname -m)" == Linux-x86_64 ]] || { echo 'CI installer requires Linux x86_64' >&2; exit 1; }
tools_dir="${RUNNER_TEMP:?}/recvfund-solana-tools"
mkdir -p "$tools_dir/bin"
fetch() {
  local url="$1" expected="$2" destination="$3"
  curl --fail --location --retry 3 --connect-timeout 30 --max-time 300 "$url" -o "$destination"
  echo "$expected  $destination" | sha256sum --check --strict
}
fetch https://github.com/anza-xyz/agave/releases/download/v2.1.21/solana-release-x86_64-unknown-linux-gnu.tar.bz2 \
  5da3359e296f1e6c13522b874317cb4cfe33e73301a9dc60b1e1435cc133b397 "$tools_dir/agave.tar.bz2"
tar -xjf "$tools_dir/agave.tar.bz2" -C "$tools_dir"
fetch https://github.com/otter-sec/anchor/releases/download/v0.31.1/anchor-0.31.1-x86_64-unknown-linux-gnu \
  5e5f8fc0f75f2c3dc5cceb082a7f735d09be2207540291ffad370eb5b2dc959b "$tools_dir/bin/anchor"
fetch https://github.com/rustsec/rustsec/releases/download/cargo-audit/v0.22.2/cargo-audit-x86_64-unknown-linux-gnu-v0.22.2.tgz \
  ab28a1bdb54db4d5d8ad5981cf1f959410370b3d28250dbd35f6a44248620e39 "$tools_dir/audit.tgz"
tar -xzf "$tools_dir/audit.tgz" -C "$tools_dir"
cp "$tools_dir/cargo-audit-x86_64-unknown-linux-gnu-v0.22.2/cargo-audit" "$tools_dir/bin/"
fetch https://github.com/solana-foundation/solana-verifiable-build/releases/download/v0.5.2/solana-verify-0.5.2-linux \
  b9d5ccce9634dc14269cab3e7a58649bc141b3306e7735a94478c936341f211f "$tools_dir/bin/solana-verify"
chmod +x "$tools_dir/bin/anchor" "$tools_dir/bin/solana-verify" "$tools_dir/bin/cargo-audit"
echo "$tools_dir/bin" >> "$GITHUB_PATH"
echo "$tools_dir/solana-release/bin" >> "$GITHUB_PATH"
corepack enable
corepack prepare yarn@1.22.22 --activate
