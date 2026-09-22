use anchor_lang::prelude::*;

/// Hard ceiling on any fee rate, in basis points (2%). Enforced in the
/// program, so no configuration change can exceed it without an upgrade.
pub const MAX_FEE_BPS: u16 = 200;

/// Denominator for basis-point fee rates.
pub const BPS_DENOMINATOR: u128 = 10_000;

pub const CONFIG_SEED: &[u8] = b"config";
pub const MERCHANT_SEED: &[u8] = b"merchant";
pub const INVOICE_SEED: &[u8] = b"invoice";
pub const DEPOSIT_SEED: &[u8] = b"deposit";

/// Vendor-controlled settings. The authority can only change the fee rates
/// (within `MAX_FEE_BPS`), the fee collector, and the authority itself; it has
/// no instruction that touches merchant funds.
#[account]
#[derive(InitSpace)]
pub struct GlobalConfig {
    pub authority: Pubkey,
    pub fee_collector: Pubkey,
    pub fee_bps_checkout: u16,
    pub fee_bps_sweep: u16,
    pub bump: u8,
}

/// One registered merchant. `settlement_wallet` is a wallet owner pubkey;
/// token settlements go to its associated token accounts. Only `admin` can
/// change it, which is what makes the program non-custodial.
#[account]
#[derive(InitSpace)]
pub struct Merchant {
    pub merchant_id: [u8; 32],
    pub admin: Pubkey,
    pub settlement_wallet: Pubkey,
    /// Key allowed to trigger sweeps in addition to `admin`. Sweeps can only
    /// move funds to the settlement wallet, so this key is an operational
    /// convenience, not a custody key.
    pub sweeper: Pubkey,
    pub is_active: bool,
    pub bump: u8,
}

/// Receipt created when an invoice is paid. Its existence is what makes a
/// second payment for the same invoice fail at account creation.
#[account]
#[derive(InitSpace)]
pub struct Invoice {
    pub merchant: Pubkey,
    pub invoice_id: [u8; 32],
    pub mint: Pubkey,
    pub payer: Pubkey,
    pub amount: u64,
    pub fee: u64,
    pub paid_at: i64,
    pub bump: u8,
}
