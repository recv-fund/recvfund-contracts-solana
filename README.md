# recvfund-contracts-solana

On-chain settlement program for recv.fund, a self-hosted, non-custodial
stablecoin payment product on Solana. Merchants run their own server; the
vendor deploys this program once. Every settlement is forced through the
program so that a percentage fee can be collected, while the program itself
can only ever move funds to the merchant's own settlement wallet and to the
fee collector.

- Program name: `recvfund`
- Program ID: `G9u3a8P6T5RFsgQhjVC5Yw7oAUqURst5MQJi1rFVkzAt`
- Framework: Anchor 0.31.1, SPL Token via `anchor-spl` (Token-2022 is not supported)
- IDL: `target/idl/recvfund.json` (after `anchor build`); TypeScript types in `target/types/recvfund.ts`

## What the program does

There are two ways money moves:

1. **Checkout (`pay`)**: a payer signs a transfer of SPL tokens for an
   invoice. The program splits the amount into `amount - fee` to the
   merchant's settlement wallet and `fee` to the fee collector, and writes an
   `Invoice` receipt so the same invoice cannot be paid twice.
2. **Deposit sweep (`sweep_token`, `sweep_sol`)**: a customer sends tokens or
   SOL to a deterministic deposit address derived from the merchant and a
   customer reference. The merchant's sweeper (or admin) later sweeps the whole
   balance to the settlement wallet, minus the fee.

No instruction accepts an arbitrary destination account. Every destination is
pinned by an `address = ...` constraint to a value stored on chain, and the
token destinations are further required to be the associated token accounts
of those addresses.

## Account model

All PDAs are derived from this program's ID.

### `GlobalConfig` (seeds `["config"]`)

| Field              | Type     | Meaning                                                  |
| ------------------ | -------- | -------------------------------------------------------- |
| `authority`        | `Pubkey` | Vendor key allowed to change fee rates and fee collector |
| `fee_collector`    | `Pubkey` | Wallet that receives fees (token fees go to its ATAs)    |
| `fee_bps_checkout` | `u16`    | Fee on `pay`, in basis points                            |
| `fee_bps_sweep`    | `u16`    | Fee on `sweep_token` and `sweep_sol`, in basis points    |
| `bump`             | `u8`     | PDA bump                                                 |

### `Merchant` (seeds `["merchant", merchant_id]`)

| Field               | Type       | Meaning                                                     |
| ------------------- | ---------- | ----------------------------------------------------------- |
| `merchant_id`       | `[u8; 32]` | Merchant-chosen identifier                                  |
| `admin`             | `Pubkey`   | Only key that can change the fields below                   |
| `settlement_wallet` | `Pubkey`   | Wallet owner; token settlements go to its ATA for each mint |
| `sweeper`           | `Pubkey`   | Key allowed to trigger sweeps (defaults to `admin`)         |
| `is_active`         | `bool`     | When false, `pay` is rejected; sweeps still work            |
| `bump`              | `u8`       | PDA bump                                                    |

### `Invoice` (seeds `["invoice", merchant_pda, invoice_id]`)

Receipt written by `pay`. Fields: `merchant`, `invoice_id`, `mint`, `payer`,
`amount`, `fee`, `paid_at` (unix seconds), `bump`. It is created with `init`,
so a second `pay` for the same `(merchant, invoice_id)` fails at account
creation.

### Deposit address (seeds `["deposit", merchant_pda, customer_ref]`)

This PDA has **no data account**. It is only an address:

- Token deposits go to its associated token account for the mint. The ATA is
  off-curve, so the creator must pass `allowOwnerOffCurve = true` (JS) or use
  `create_associated_token_account` with the PDA as owner.
- SOL deposits are plain lamports held at the address itself. It stays a
  system-owned, data-less account.

The program signs with the PDA seeds only inside `sweep_token` and
`sweep_sol`, and only towards the settlement wallet and the fee collector.

## Instructions

Names below are the on-chain (snake_case) names. The Anchor TypeScript client
exposes them, their accounts and events in camelCase.

### Vendor configuration (signer: `authority`)

| Instruction                                                 | Accounts                                   | Notes                                                    |
| ----------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------- |
| `initialize_config(fee_collector, fee_bps_checkout, fee_bps_sweep)` | `authority` (signer, mut), `config` (init), `system_program` | Signer becomes `authority`. Both rates must be `<= 200`. |
| `set_fees(fee_bps_checkout, fee_bps_sweep)`                 | `authority` (signer), `config` (mut)       | Both rates must be `<= 200`.                             |
| `set_fee_collector(new_fee_collector)`                      | `authority` (signer), `config` (mut)       |                                                          |
| `transfer_authority(new_authority)`                         | `authority` (signer), `config` (mut)       | Single step; the new key is not validated.               |

### Merchant self-service (signer: merchant `admin`)

| Instruction                                       | Accounts                                              | Notes                                                                 |
| ------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------- |
| `register_merchant(merchant_id, settlement_wallet)` | `admin` (signer, mut), `merchant` (init), `system_program` | Anyone can call. Signer becomes `admin` and `sweeper`. Wallet must not be the zero pubkey. |
| `set_settlement_wallet(new_settlement_wallet)`    | `admin` (signer), `merchant` (mut)                    | Wallet must not be the zero pubkey.                                   |
| `set_sweeper(new_sweeper)`                        | `admin` (signer), `merchant` (mut)                    |                                                                       |
| `set_merchant_active(is_active)`                  | `admin` (signer), `merchant` (mut)                    | Inactive merchants reject `pay`; sweeps are unaffected.               |

### Fund movement

`pay(invoice_id, amount)` - signer: `payer`

| Account                      | Constraints                                                         |
| ---------------------------- | ------------------------------------------------------------------- |
| `payer`                      | signer, mut; pays rent for the receipt and any missing ATAs         |
| `config`                     | PDA `["config"]`                                                    |
| `merchant`                   | PDA `["merchant", merchant_id]`                                     |
| `invoice`                    | init, PDA `["invoice", merchant, invoice_id]`                       |
| `mint`                       | SPL Token mint                                                      |
| `payer_token_account`        | mut, `mint` must match; the token program checks the payer's authority |
| `settlement_wallet`          | `address = merchant.settlement_wallet`                              |
| `settlement_token_account`   | init_if_needed, ATA of (`settlement_wallet`, `mint`)                |
| `fee_collector`              | `address = config.fee_collector`                                    |
| `fee_collector_token_account`| init_if_needed, ATA of (`fee_collector`, `mint`)                    |
| `token_program`, `associated_token_program`, `system_program` |                                     |

Rejects `amount == 0` (`ZeroAmount`) and inactive merchants
(`MerchantInactive`). Emits `PaymentReceived { merchant_id, invoice_id, mint, amount, fee, payer }`.

`sweep_token(customer_ref)` - signer: merchant `sweeper` or `admin`

| Account                      | Constraints                                                         |
| ---------------------------- | ------------------------------------------------------------------- |
| `signer`                     | signer, mut; must equal `merchant.sweeper` or `merchant.admin`; receives the closed ATA's rent and pays for missing destination ATAs |
| `config`, `merchant`         | as above                                                            |
| `deposit_authority`          | PDA `["deposit", merchant, customer_ref]`, no data                  |
| `mint`                       | SPL Token mint                                                      |
| `deposit_token_account`      | mut, ATA of (`deposit_authority`, `mint`)                           |
| `settlement_wallet`, `settlement_token_account`, `fee_collector`, `fee_collector_token_account` | as in `pay` |
| `token_program`, `associated_token_program`, `system_program` |                                     |

Moves the entire balance, then closes the deposit ATA. Rejects an empty
balance (`NothingToSweep`). Emits `DepositSwept { merchant_id, customer_ref, mint, amount, fee }`.

`sweep_sol(customer_ref)` - signer: merchant `sweeper` or `admin`

| Account             | Constraints                                          |
| ------------------- | ---------------------------------------------------- |
| `signer`            | signer; must equal `merchant.sweeper` or `merchant.admin` |
| `config`, `merchant`| as above                                             |
| `deposit_authority` | mut, PDA `["deposit", merchant, customer_ref]`       |
| `settlement_wallet` | mut, `address = merchant.settlement_wallet`          |
| `fee_collector`     | mut, `address = config.fee_collector`                |
| `system_program`    |                                                      |

Transfers every lamport out of the deposit address, leaving it at 0. Emits
`DepositSwept` with `mint = Pubkey::default()` (all zeros) to mark native SOL.
Note that the system program refuses a transfer that would leave the
*destination* below rent exemption while non-zero, so a settlement wallet or
fee collector that has never been funded cannot receive a sweep smaller than
roughly 0.0009 SOL.

### Errors

| Code | Name                      |
| ---- | ------------------------- |
| 6000 | `FeeTooHigh`              |
| 6001 | `ZeroAmount`              |
| 6002 | `MerchantInactive`        |
| 6003 | `Unauthorized`            |
| 6004 | `MathOverflow`            |
| 6005 | `NothingToSweep`          |
| 6006 | `InvalidSettlementWallet` |

## Fee cap and fee math

`MAX_FEE_BPS = 200` (2%) is a constant in `programs/recvfund/src/state.rs`.
`initialize_config` and `set_fees` reject any rate above it, and
`fee::compute_fee` checks it again before use, so a rate above the cap cannot
be stored or applied without a program upgrade. Rates below the cap can be
changed at any time by the authority.

`fee = amount * bps / 10_000`, rounded down, computed in `u128` with checked
arithmetic (`programs/recvfund/src/fee.rs`). No floating point is used. When
the fee rounds to zero the fee transfer is skipped.

## Non-custodial invariants and how the code enforces them

1. **A merchant's settlement wallet is set and changed only by that merchant's
   admin key.**
   `register_merchant` writes `settlement_wallet` from the signer's argument
   and records the signer as `admin`. `set_settlement_wallet` uses the
   `MerchantAdminOnly` context, whose `has_one = admin` constraint requires the
   stored admin to sign (`programs/recvfund/src/instructions/merchant.rs`).
   No other instruction writes this field.

2. **The program can move merchant funds only to the settlement wallet and the
   fee collector.**
   In `pay`, `sweep_token` and `sweep_sol` the destination wallets are
   `UncheckedAccount`s pinned with `address = merchant.settlement_wallet` and
   `address = config.fee_collector`. Token destinations are constrained with
   `associated_token::authority = <that wallet>` and
   `associated_token::mint = mint`, so they must be the ATAs of those exact
   wallets. The deposit PDA's signature is produced only inside these two
   sweep instructions. There is no instruction that takes a free-form
   destination.

3. **Fee rates come from a vendor-controlled config with a hard 200 bps
   maximum.**
   See "Fee cap and fee math". The cap is enforced on write and on read.

4. **No pause or freeze; the vendor authority cannot move funds.**
   There is no instruction that halts payments or sweeps globally. The only
   merchant-level switch, `is_active`, is admin-controlled and affects `pay`
   only; sweeps keep working so deposits are never trapped. The four
   authority-gated instructions (`initialize_config`, `set_fees`,
   `set_fee_collector`, `transfer_authority`) reference no token accounts, no
   merchant account and no deposit PDA. The test suite includes a check that
   the authority calling `sweep_token` and `sweep_sol` is rejected with
   `Unauthorized`, and an IDL-level check that no authority-gated instruction
   touches the token program, a settlement wallet or a deposit address.

5. **Upgrade authority.** See the section below.

What the vendor authority *can* do: change the fee collector (which changes
where future fees go, not where merchant funds go) and change rates within
the cap.

## Build and test

Requirements: Rust with `cargo`, `solana-cli` 2.1.x (its `cargo build-sbf`
ships platform-tools with rustc 1.79), `anchor-cli` 0.31.1, Node >= 20, Yarn 1.

```sh
yarn install
anchor build          # produces target/deploy/recvfund.so, target/idl, target/types
anchor test           # starts a local validator and runs tests/recvfund.ts
```

`Cargo.lock` is committed and pins a handful of transitive crates (`blake3`,
`indexmap`, `proc-macro-crate`, `zeroize`, ...) to versions that compile
with rustc 1.79. Do not run a blanket `cargo update`; if you add a dependency,
check that `anchor build` still succeeds.

`anchor test` reads the wallet path from `Anchor.toml`
(`~/.config/solana/id.json` by default). To use a different keypair:

```sh
anchor test --provider.wallet /path/to/keypair.json
```

The program keypair in `target/deploy/recvfund-keypair.json` determines the
program ID and is gitignored. Keep the one used for the real deployment in a
secure location; a fresh clone without it will generate a new ID on
`anchor keys sync`, which must then be aligned with `declare_id!` and
`Anchor.toml` before building.

## Deploy to devnet

```sh
solana config set --url devnet
solana airdrop 5                      # repeat as needed; deployment costs ~2.5 SOL
anchor build
anchor deploy --provider.cluster devnet
anchor idl init --provider.cluster devnet -f target/idl/recvfund.json G9u3a8P6T5RFsgQhjVC5Yw7oAUqURst5MQJi1rFVkzAt
```

Then call `initialize_config` once from the vendor authority key. The
`[programs.devnet]` entry in `Anchor.toml` already carries the program ID.

## Upgrade authority

The deploying wallet is the upgrade authority after `anchor deploy`. While
that key exists, whoever holds it can replace the program and, with it, every
invariant above. Before mainnet use, one of the following must be done and
the outcome published:

- **Burn it**: `solana program set-upgrade-authority <PROGRAM_ID> --final`.
  The program becomes immutable. Bug fixes then require a new deployment
  under a new program ID and a merchant migration.
- **Move it to a multisig** (for example Squads):
  `solana program set-upgrade-authority <PROGRAM_ID> --new-upgrade-authority <MULTISIG>`.
  Upgrades stay possible but need a quorum, and the multisig's members and
  threshold should be documented so merchants can evaluate the risk.

Until this is done, the non-custodial guarantees hold only as long as the
upgrade key is not misused. Merchants integrating against devnet should treat
the deployment as provisional.

## Integration notes for the server

- Instruction discriminators, account order and argument encoding come from
  the IDL at `target/idl/recvfund.json`; use the Anchor client or a Codama
  generated client rather than hand-rolling them.
- PDA seeds are listed under "Account model". `merchant_id`, `invoice_id` and
  `customer_ref` are opaque 32-byte values chosen by the server (for example
  a SHA-256 of an internal id).
- Deposit addresses are derived off chain; nothing has to be created on chain
  before a customer can deposit. For token deposits the payer's wallet will
  usually create the deposit ATA itself; if it does not, the server can create
  it (allow off-curve owner). The ATA is closed on sweep and recreated on the
  next deposit.
- `pay` and `sweep_token` create the settlement and fee collector ATAs if
  missing; the transaction signer pays that rent.
- Events are emitted with `emit!` and appear as `Program data:` log lines.
  Decode them with `EventParser` from the transaction logs. The Anchor
  TypeScript client camelCases event names (`paymentReceived`, `depositSwept`).
- `DepositSwept.mint` is the zero pubkey for SOL sweeps.
- The provider wallet in the Anchor client is the fee payer by default; the
  instruction's own signer (`payer`, `signer`, `admin`, `authority`) can be a
  different keypair added with `.signers([...])`.
