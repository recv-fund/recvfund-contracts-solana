# Security and release requirements

This program has not received an independent audit recorded in this repository.
Automated checks do not establish that a contract is safe against all attacks.
The 2026-10-05 source fixes are local release candidates; the documented public
devnet deployment has not been upgraded and still carries the old bytecode.

## Confirmed and corrected root causes

1. **First-caller configuration takeover.** A real local-validator regression
   proved an outsider could initialize the global config before the vendor,
   selecting themselves as fee authority and collector. Bootstrap now checks
   the current executable's loader-owned ProgramData and requires its upgrade
   authority to sign. Existing configs and merchant layouts remain unchanged.
   The init instruction now requires two extra read-only accounts: `program`
   and `program_data`. Updated tooling derives ProgramData from `[program_id]`
   under `BPFLoaderUpgradeab1e11111111111111111111111`. Initialize the config
   **before** revoking upgrade authority.
2. **Collector-controlled token sweep denial.** A real local-validator regression
   changed the collector's canonical SPL ATA owner. The prior Anchor account
   constraint aborted the whole sweep before the fee-redirect handler could
   run. The account is now pinned to the exact canonical address, with its
   token owner/mint/frozen state checked in the handler. An undeliverable fee
   goes to settlement. The caller cannot nominate another collector account.

Before/after runtime evidence is retained under `security/artifacts/` locally.
See [the dated review](security/REVIEW-2026-10-05.md) for exact check results.

## Reproduce verification

Install the toolchains described in README, plus
[`cargo-audit`](https://github.com/rustsec/rustsec/tree/main/cargo-audit).
Run `bash scripts/security-check.sh`. It checks formatting, Rust units, strict
Clippy, advisory data, TypeScript, the actual SBF build, and the full local
validator suite using a disposable wallet. No real keys or public cluster are
required. An advisory warning still needs review even when cargo-audit exits 0.

The checked-in Cargo.lock resolves Anchor Rust dependencies to 0.31.2; the CLI
and JS client are 0.31.1. Keep the lockfile. Do not update the whole dependency
tree without rebuilding the program, checking IDL, and rerunning the validator.

## Remaining trust boundaries

- **Upgrade authority:** a live upgrade key can replace all program logic. The
  current devnet deployment is explicitly provisional. Review multisig/timelock
  governance or intentional immutability before mainnet; do not revoke authority
  before first config initialization or before planning recovery and migration.
- **Merchant IDs:** merchant PDAs use `["merchant", merchant_id]`, not the admin
  key. IDs are globally first-come-first-served. Verify the registered admin,
  settlement wallet, sweeper and immutable fee terms before giving customers
  any deposit address. Never assume an ID identifies its intended merchant.
  Admin-scoped seeds would need a versioned migration and new deposit addresses.
- **Tokens:** only classic SPL Token is supported. Frozen deposits/settlement
  accounts can block that merchant; arbitrary Token-2022 extensions are outside
  scope. Test the actual allowed mint and token-program owner on the target chain.
- **Authority transfer:** fee-authority transfer is one-step and permits the
  default key (permanent loss of config control). It does not control existing
  merchants, but operators must independently verify the destination key.
- **Secrets and RPC:** a compromised merchant admin can change settlement;
  a compromised RPC can misreport payment or bytecode. Hardware/multisig key
  controls, trusted deployment provenance, confirmations and reorg policy remain
  necessary outside the program.

## Release gates

Obtain an independent audit of the exact final source and binary, verify an
immutable build against the deployed program and ProgramData authority, then
run funded devnet SPL/SOL settlement and failure scenarios through the real
server and browser. Publish candidate and deployed provenance separately. Do
not overwrite a public deployment's pinned hash with a local candidate hash:
the server must keep rejecting an unsupported binary. Source verification is
not a security audit ([Solana verified builds](https://solana.com/docs/programs/verified-builds)).
