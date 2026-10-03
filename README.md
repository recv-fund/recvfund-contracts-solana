# recvfund-contracts-solana

On-chain settlement program for recv.fund, a self-hosted, non-custodial
stablecoin payment product on Solana. Merchants run their own server; the
vendor deploys this program once. Customers pay a per-customer deposit
address that belongs to the merchant, and the program moves a deposit only
to the merchant's settlement wallet and to the fee collector recorded in that
merchant's account, taking the fee at that point.

- Program name: `recvfund`
- Program ID: `FAZUvvc2anrhgkP6sVczAHp2wkFCfhzpFcbiBt1mVM8J`
- Framework: Anchor 0.31.1, SPL Token via `anchor-spl` (Token-2022 is not supported)
- IDL: `target/idl/recvfund.json` (after `anchor build`); TypeScript types in `target/types/recvfund.ts`

The previous program ID `G9u3a8P6T5RFsgQhjVC5Yw7oAUqURst5MQJi1rFVkzAt` used
a different account layout and had a `pay` instruction. Its devnet deployment
is superseded; see "Deployments".

## What the program does

There is one way money moves:

1. A customer sends SPL tokens or SOL to a deterministic deposit address
   derived from the merchant and a customer reference. This is an ordinary
   transfer to an address the merchant controls through the program; no
   vendor code runs and no fee is taken at this point.
2. The merchant's sweeper (or admin) calls `sweep_token` or `sweep_sol`. The
   program moves the whole balance: `amount - fee` to the merchant's
   settlement wallet and `fee` to the fee collector stored in the merchant
   account, at the rate stored in the merchant account.

The vendor publishes fee terms (fee collector and rate) in `GlobalConfig`.
A merchant receives a copy of the terms in force when it registers, and those
terms never change for that merchant. A later change by the vendor applies
only to merchants that register after it.

No instruction accepts an arbitrary destination account. Every destination is
pinned by an `address = ...` constraint to a value stored in the merchant
account, and the token destinations are further required to be the
associated token accounts of those addresses.

## Account model

All PDAs are derived from this program's ID.

### `GlobalConfig` (seeds `["config"]`, 75 bytes)

| Field           | Type     | Meaning                                                              |
| --------------- | -------- | -------------------------------------------------------------------- |
| `authority`     | `Pubkey` | Vendor key allowed to change the fee terms and transfer authority    |
| `fee_collector` | `Pubkey` | Fee collector given to merchants that register from now on           |
| `fee_bps`       | `u16`    | Sweep fee rate, in basis points, given to merchants that register from now on |
| `bump`          | `u8`     | PDA bump                                                             |

Nothing reads `fee_collector` or `fee_bps` from this account except
`register_merchant`, which copies them into the new merchant.

### `Merchant` (seeds `["merchant", merchant_id]`, 172 bytes)

| Field               | Type       | Meaning                                                              |
| ------------------- | ---------- | -------------------------------------------------------------------- |
| `merchant_id`       | `[u8; 32]` | Merchant-chosen identifier                                           |
| `admin`             | `Pubkey`   | Only key that can change `settlement_wallet`, `sweeper`, `is_active` |
| `settlement_wallet` | `Pubkey`   | Wallet owner; token settlements go to its ATA for each mint          |
| `sweeper`           | `Pubkey`   | Key allowed to trigger sweeps in addition to `admin`                 |
| `is_active`         | `bool`     | Read by the merchant's server only; the program does not check it    |
| `fee_collector`     | `Pubkey`   | Copied from `GlobalConfig` at registration; never changes            |
| `fee_bps`           | `u16`      | Copied from `GlobalConfig` at registration; never changes            |
| `bump`              | `u8`       | PDA bump                                                             |

### Deposit address (seeds `["deposit", merchant_pda, customer_ref]`)

This PDA has **no data account**. It is only an address:

- Token deposits go to its associated token account for the mint. The ATA is
  off-curve, so the creator must pass `allowOwnerOffCurve = true` (JS) or use
  `create_associated_token_account` with the PDA as owner.
- SOL deposits are plain lamports held at the address itself. It stays a
  system-owned, data-less account.

The program signs with the PDA seeds only inside `sweep_token` and
`sweep_sol`, and only towards the settlement wallet and the merchant's fee
collector.

## Instructions

Names below are the on-chain (snake_case) names. The Anchor TypeScript client
exposes them, their accounts and events in camelCase.

### Vendor configuration (signer: `authority`)

| Instruction                                  | Accounts                                                     | Notes |
| -------------------------------------------- | ------------------------------------------------------------ | ----- |
| `initialize_config(fee_collector, fee_bps)`  | `authority` (signer, mut), `config` (init), `system_program` | Once. Signer becomes `authority`. `fee_bps <= 200`, `fee_collector` not the zero pubkey. Emits `FeeTermsUpdated`. |
| `set_fee_terms(fee_collector, fee_bps)`      | `authority` (signer), `config` (mut)                         | Same validation. Applies only to merchants registered afterwards. Emits `FeeTermsUpdated`. |
| `transfer_authority(new_authority)`          | `authority` (signer), `config` (mut)                         | Single step; the new key is not validated. |

### Merchant self-service (signer: merchant `admin`)

| Instruction                                                  | Accounts                                                                    | Notes |
| ------------------------------------------------------------ | --------------------------------------------------------------------------- | ----- |
| `register_merchant(merchant_id, settlement_wallet, sweeper)` | `admin` (signer, mut, payer), `config` (PDA `["config"]`, read), `merchant` (init, PDA `["merchant", merchant_id]`), `system_program` | Anyone can call. Signer becomes `admin`. Settlement wallet and sweeper must not be the zero pubkey. Copies `config.fee_collector` and `config.fee_bps` into the merchant. Emits `MerchantRegistered`. One instruction does the whole registration. |
| `set_settlement_wallet(new_settlement_wallet)`               | `admin` (signer), `merchant` (mut)                                          | Wallet must not be the zero pubkey. |
| `set_sweeper(new_sweeper)`                                   | `admin` (signer), `merchant` (mut)                                          | |
| `set_merchant_active(is_active)`                             | `admin` (signer), `merchant` (mut)                                          | Flag for the merchant's server. Sweeps are unaffected. |

No instruction changes a merchant's `fee_collector` or `fee_bps`.

### Fund movement

`sweep_token(customer_ref)` - signer: merchant `sweeper` or `admin`

| Account                       | Constraints |
| ----------------------------- | ----------- |
| `signer`                      | signer, mut; must equal `merchant.sweeper` or `merchant.admin`; pays for missing destination ATAs and receives the closed deposit ATA's rent |
| `merchant`                    | PDA `["merchant", merchant_id]` |
| `deposit_authority`           | PDA `["deposit", merchant, customer_ref]`, no data |
| `mint`                        | SPL Token mint |
| `deposit_token_account`       | mut, ATA of (`deposit_authority`, `mint`) |
| `settlement_wallet`           | `address = merchant.settlement_wallet` |
| `settlement_token_account`    | init_if_needed, ATA of (`settlement_wallet`, `mint`) |
| `fee_collector`               | `address = merchant.fee_collector` |
| `fee_collector_token_account` | init_if_needed, ATA of (`fee_collector`, `mint`) |
| `token_program`, `associated_token_program`, `system_program` | |

Moves the entire balance, then closes the deposit ATA. A later deposit
recreates the ATA at the same address. Rejects an empty balance
(`NothingToSweep`). Emits `DepositSwept { merchant_id, customer_ref, mint, amount, fee }`.

`sweep_sol(customer_ref)` - signer: merchant `sweeper` or `admin`

| Account             | Constraints |
| ------------------- | ----------- |
| `signer`            | signer; must equal `merchant.sweeper` or `merchant.admin` |
| `merchant`          | PDA `["merchant", merchant_id]` |
| `deposit_authority` | mut, PDA `["deposit", merchant, customer_ref]` |
| `settlement_wallet` | mut, `address = merchant.settlement_wallet` |
| `fee_collector`     | mut, `address = merchant.fee_collector` |
| `system_program`    | |

Transfers every lamport out of the deposit address, leaving it at 0. Emits
`DepositSwept` with `mint = Pubkey::default()` (all zeros) to mark native SOL.
The system program refuses a transfer that would leave the *destination*
below rent exemption while non-zero, so a settlement wallet or fee collector
that has never been funded cannot receive a sweep or a fee smaller than
roughly 0.0009 SOL.

Neither sweep takes the `config` account: the rate and the fee collector come
from the merchant account only.

### Events

| Event                | Fields                                                                    | Emitted by |
| -------------------- | ------------------------------------------------------------------------- | ---------- |
| `FeeTermsUpdated`    | `fee_collector: Pubkey, fee_bps: u16`                                     | `initialize_config`, `set_fee_terms` |
| `MerchantRegistered` | `merchant_id: [u8; 32], admin, settlement_wallet, sweeper, fee_collector: Pubkey, fee_bps: u16` | `register_merchant` |
| `DepositSwept`       | `merchant_id: [u8; 32], customer_ref: [u8; 32], mint: Pubkey, amount: u64, fee: u64` | `sweep_token`, `sweep_sol` |

### Errors

| Code | Name                      |
| ---- | ------------------------- |
| 6000 | `FeeTooHigh`              |
| 6001 | `Unauthorized`            |
| 6002 | `MathOverflow`            |
| 6003 | `NothingToSweep`          |
| 6004 | `InvalidSettlementWallet` |
| 6005 | `InvalidSweeper`          |
| 6006 | `InvalidFeeCollector`     |

These codes differ from the superseded program, which had `ZeroAmount` and
`MerchantInactive` at 6001 and 6002.

## Fee cap and fee math

`MAX_FEE_BPS = 200` (2%) is a constant in `programs/recvfund/src/state.rs`.
`initialize_config` and `set_fee_terms` reject any rate above it, so no
merchant can be registered with a higher rate, and `fee::compute_fee` checks
it again at sweep time. A rate above the cap cannot be stored or applied
without a program upgrade.

`fee = amount * fee_bps / 10_000`, rounded down, computed in `u128` with
checked arithmetic (`programs/recvfund/src/fee.rs`), where `amount` is the
whole deposit balance and `fee_bps` is the merchant's stored rate. No floating
point is used. The settlement wallet receives `amount - fee`. When the fee
rounds to zero (for example 199 units at 50 bps) the fee transfer is skipped
and the settlement wallet receives the whole amount. A merchant registered
while the rate was 0 never pays a fee.

## Non-custodial invariants and how the code enforces them

1. **The vendor is never in the payment path.**
   There is no checkout instruction. Customers pay the merchant's deposit
   address with an ordinary token or SOL transfer. The program only acts when
   the merchant's own sweeper or admin calls a sweep.

2. **Funds leave a deposit address only to the merchant's settlement wallet
   and the fee collector stored in that merchant's account.**
   The deposit PDA's signature is produced only inside `sweep_token` and
   `sweep_sol`. Their destination wallets are `UncheckedAccount`s pinned with
   `address = merchant.settlement_wallet` and
   `address = merchant.fee_collector`. Token destinations are constrained with
   `associated_token::authority = <that wallet>` and
   `associated_token::mint = mint`, so they must be the ATAs of those exact
   wallets. No instruction takes a free-form destination.

3. **A merchant's settlement wallet is set and changed only by that
   merchant's admin key.**
   `register_merchant` records the signer as `admin`, and
   `set_settlement_wallet` uses the `MerchantAdminOnly` context, whose
   `has_one = admin` constraint requires the stored admin to sign
   (`programs/recvfund/src/instructions/merchant.rs`). No other instruction
   writes this field.

4. **A merchant's fee terms are fixed at registration.**
   `register_merchant` copies `fee_collector` and `fee_bps` from the config
   into the merchant account. No instruction writes those two fields
   afterwards, and the sweeps do not read the config account at all. The test
   suite registers a merchant, changes the vendor terms, and checks that the
   merchant's sweeps still use the old rate and old collector and reject the
   new collector.

5. **The vendor authority affects only future registrations and cannot move
   funds.**
   The authority-gated instructions (`initialize_config`, `set_fee_terms`,
   `transfer_authority`) reference no merchant account, no token account and
   no deposit address. The authority cannot sign a sweep (rejected with
   `Unauthorized`). There is no pause or freeze. The test suite checks both,
   including an IDL-level check of the accounts each instruction takes.

6. **Fee rates are capped at 200 bps.** See "Fee cap and fee math".

7. **Upgrade authority.** All of the above hold only while the program code
   cannot be replaced. See "Upgrade authority".

`is_active` has no effect on the program; only the merchant's server reads
it. Sweeps keep working while it is false, so deposits are never trapped.

## Build and test

Requirements: Rust with `cargo`, `solana-cli` 2.1.x (its `cargo build-sbf`
ships platform-tools with rustc 1.79), `anchor-cli` 0.31.1, Node >= 20, Yarn 1.

```sh
yarn install
anchor build                       # target/deploy/recvfund.so, target/idl, target/types
anchor test                        # local validator, runs tests/recvfund.ts
cargo test -p recvfund --lib fee   # fee math unit tests
yarn lint                          # prettier check of the tests
```

`Cargo.lock` is committed and pins a handful of transitive crates (`blake3`,
`indexmap`, `proc-macro-crate`, `zeroize`, ...) to versions that compile
with rustc 1.79. Do not run a blanket `cargo update`; if you add a dependency,
check that `anchor build` still succeeds.

`anchor test` reads the wallet path from `Anchor.toml`
(`~/.config/solana/id.json` by default). To use a throwaway keypair:

```sh
solana-keygen new -o /tmp/recv-test-wallet.json --no-bip39-passphrase --force
anchor test --provider.wallet /tmp/recv-test-wallet.json
```

The program keypair in `target/deploy/recvfund-keypair.json` determines the
program ID and is gitignored. A fresh clone without it will produce a
different ID; `declare_id!` in `programs/recvfund/src/lib.rs` and both entries
in `Anchor.toml` must match the keypair before building. The vendor keeps the
keypair for `FAZUvvc2anrhgkP6sVczAHp2wkFCfhzpFcbiBt1mVM8J` outside the
repository; the keypair of the superseded ID is archived at
`~/.recvfund/keys/solana-program-v1-keypair.json` on the vendor machine.

## Deployments

| Cluster | Program | Status |
|---|---|---|
| devnet | `FAZUvvc2anrhgkP6sVczAHp2wkFCfhzpFcbiBt1mVM8J` | not deployed |
| mainnet-beta | `FAZUvvc2anrhgkP6sVczAHp2wkFCfhzpFcbiBt1mVM8J` | not deployed |
| devnet | `G9u3a8P6T5RFsgQhjVC5Yw7oAUqURst5MQJi1rFVkzAt` | **superseded**; old account layout with `pay`, do not integrate |

The superseded devnet deployment (2026-09-30, slot 505871112, commit
`850c891`, 343104-byte binary with SHA-256
`baedd33872b60cfd7cefccfadcdb5e31bbfbe17d84142fcb8b6257bc4339ac1e`, upgrade
authority `58tYVJZ3DadHLW7aA4gGAWNxS1dEkm6ifseFqZ4LyTcV`, config
`TnJcc8jek4ZzrzijxGgcwRU55fdXxBU3t3Ty91vrTKr` at 75 / 100 bps) still exists
on chain. Its account layout is incompatible with this code.

The config PDA of the current program ID is
`5uLBoziU1on7DmPDyYPobgZhkFeWtjy91GW3HGWxFLcT` on every cluster.

## Deploy

```sh
solana config set --url devnet        # or mainnet-beta
solana balance                        # rent for a ~300 KB program is about 2.2 SOL
anchor build
shasum -a 256 target/deploy/recvfund.so
anchor deploy --provider.cluster devnet --provider.wallet <deployer keypair>
```

`anchor deploy` uses `target/deploy/recvfund-keypair.json` as the program
address, so that keypair must be the one for the ID in `declare_id!`.
Optionally publish the IDL on chain:

```sh
anchor idl init --provider.cluster devnet -f target/idl/recvfund.json FAZUvvc2anrhgkP6sVczAHp2wkFCfhzpFcbiBt1mVM8J
```

### Configure after deploying

`scripts/init-config.cjs` creates the config PDA once with the initial fee
terms; the signing keypair becomes the fee authority. It reads
`target/idl/recvfund.json`.

```sh
RPC_URL=<cluster rpc> AUTHORITY_KEYPAIR=<path> FEE_COLLECTOR=<address> \
  FEE_BPS=100 node scripts/init-config.cjs
```

`FEE_BPS` is an integer from 0 to 200. Run the script again without the fee
variables to print the current config. Merchants cannot register until the
config exists. Later changes use `set_fee_terms` from the authority key and
apply only to merchants registered after the change.

## Upgrade authority

The deploying wallet is the upgrade authority after `anchor deploy`. While
that key exists, whoever holds it can replace the program and, with it, every
invariant above, including the per-merchant fee terms.

Mainnet procedure:

1. Deploy as above from a clean checkout of a tagged commit, and record the
   local `shasum -a 256 target/deploy/recvfund.so` and its byte length.
2. Verify that the deployed binary is that build:
   ```sh
   solana program dump -u mainnet-beta <PROGRAM_ID> /tmp/recvfund-onchain.so
   head -c <local byte length> /tmp/recvfund-onchain.so | shasum -a 256
   ```
   The hash must equal the local one. (`head -c` removes trailing zero
   padding if the program account was allocated larger than the binary.)
3. Remove the upgrade authority:
   ```sh
   solana program set-upgrade-authority -u mainnet-beta <PROGRAM_ID> --final
   ```
4. Check that `solana program show -u mainnet-beta <PROGRAM_ID>` reports no
   upgrade authority, then publish the program ID and binary hash.

The program is then immutable. Bug fixes require a new deployment under a new
program ID and a merchant migration.

The merchant server refuses a mainnet program that still has an upgrade
authority. Devnet deployments may keep one for testing; merchants
integrating against devnet should treat them as provisional.

## Integration notes for the server

- Instruction discriminators, account order and argument encoding come from
  the IDL at `target/idl/recvfund.json`; use the Anchor client or a Codama
  generated client rather than hand-rolling them.
- PDA seeds are listed under "Account model". `merchant_id` and
  `customer_ref` are opaque 32-byte values chosen by the server (for example
  a SHA-256 of an internal id).
- Registration is one `register_merchant` transaction signed by the admin;
  pass the server's hot wallet as `sweeper`. Read the fee terms the merchant
  received from the `Merchant` account or the `MerchantRegistered` event, not
  from `GlobalConfig`.
- Deposit addresses are derived off chain; nothing has to be created on chain
  before a customer can deposit. For token deposits the payer's wallet will
  usually create the deposit ATA itself; if it does not, the server can create
  it (allow off-curve owner). The ATA is closed on sweep and recreated on the
  next deposit.
- Pass `merchant.fee_collector` as the sweep's `fee_collector` account; any
  other value fails with `ConstraintAddress`.
- `sweep_token` creates the settlement and fee collector ATAs if missing; the
  sweep signer pays that rent and receives the deposit ATA's rent back.
- Events are emitted with `emit!` and appear as `Program data:` log lines.
  Decode them with `EventParser` from the transaction logs. The Anchor
  TypeScript client camelCases event names (`depositSwept`,
  `merchantRegistered`, `feeTermsUpdated`).
- `DepositSwept.mint` is the zero pubkey for SOL sweeps.
- The provider wallet in the Anchor client is the fee payer by default; the
  instruction's own signer (`signer`, `admin`, `authority`) can be a
  different keypair added with `.signers([...])`.

## Handover rule

This repo is worked on by many agents across sessions. Before finishing any
task: commit in small conventional commits as the git global user (no
trailers), update this README and `docs/` so they stay true, and append a
dated entry to `../recvfund-planning/PROGRESS.md` (Handover log) with what
changed, what was verified and how, what is broken, and the next step. Full
rule: `../AGENTS.md`.
