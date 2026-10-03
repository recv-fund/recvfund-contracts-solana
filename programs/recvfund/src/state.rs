use anchor_lang::prelude::*;

/// Hard ceiling on any fee rate, in basis points (2%). Enforced in the
/// program, so no configuration change can exceed it without an upgrade.
pub const MAX_FEE_BPS: u16 = 200;

/// Denominator for basis-point fee rates.
pub const BPS_DENOMINATOR: u128 = 10_000;

pub const CONFIG_SEED: &[u8] = b"config";
pub const MERCHANT_SEED: &[u8] = b"merchant";
pub const DEPOSIT_SEED: &[u8] = b"deposit";

/// Vendor-controlled fee terms offered to merchants that register from now
/// on. `register_merchant` copies `fee_collector` and `fee_bps` into the new
/// `Merchant` account; nothing reads them after that. Changing them therefore
/// affects only merchants registered afterwards, never an existing merchant.
///
/// The authority can change the fee terms (within `MAX_FEE_BPS`) and the
/// authority itself. It has no instruction that touches merchant funds or
/// merchant accounts.
#[account]
#[derive(InitSpace)]
pub struct GlobalConfig {
    pub authority: Pubkey,
    pub fee_collector: Pubkey,
    pub fee_bps: u16,
    pub bump: u8,
}

/// One registered merchant. `settlement_wallet` is a wallet owner pubkey;
/// token settlements go to its associated token accounts. Only `admin` can
/// change it, which is what makes the program non-custodial.
///
/// `fee_collector` and `fee_bps` are copied from `GlobalConfig` when the
/// merchant registers and no instruction writes them afterwards. Sweeps read
/// the fee terms from here, so the terms a merchant registered under are the
/// terms that apply for the lifetime of the account.
#[account]
#[derive(InitSpace)]
pub struct Merchant {
    pub merchant_id: [u8; 32],
    pub admin: Pubkey,
    pub settlement_wallet: Pubkey,
    /// Key allowed to trigger sweeps in addition to `admin`. Sweeps can only
    /// move funds to the settlement wallet and this merchant's fee collector,
    /// so this key is an operational key, not a custody key.
    pub sweeper: Pubkey,
    /// Read only by the merchant's server. The program does not consult it;
    /// sweeps work regardless so that deposits are never trapped.
    pub is_active: bool,
    /// Fee collector fixed at registration. Immutable.
    pub fee_collector: Pubkey,
    /// Sweep fee rate fixed at registration, in basis points. Immutable.
    pub fee_bps: u16,
    pub bump: u8,
}
