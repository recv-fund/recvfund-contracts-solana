use anchor_lang::prelude::*;

/// Emitted by `initialize_config` and `set_fee_terms`. These are the terms a
/// merchant that registers from now on will receive; existing merchants keep
/// the terms stored in their own account.
#[event]
pub struct FeeTermsUpdated {
    pub fee_collector: Pubkey,
    pub fee_bps: u16,
}

/// Emitted by `register_merchant`. `fee_collector` and `fee_bps` are the
/// terms stored in the merchant account; they never change afterwards.
#[event]
pub struct MerchantRegistered {
    pub merchant_id: [u8; 32],
    pub admin: Pubkey,
    pub settlement_wallet: Pubkey,
    pub sweeper: Pubkey,
    pub fee_collector: Pubkey,
    pub fee_bps: u16,
}

/// Emitted by a sweep when the fee collector could not accept the fee (a SOL
/// fee that would leave the collector below rent exemption, or a frozen
/// collector token account). The fee went to the settlement wallet instead,
/// and the sweep's `DepositSwept.fee` is zero.
#[event]
pub struct FeeRedirected {
    pub merchant_id: [u8; 32],
    pub customer_ref: [u8; 32],
    pub mint: Pubkey,
    pub fee: u64,
}

/// Emitted by both token and SOL sweeps. For SOL, `mint` is
/// `Pubkey::default()` (all zeros) because native lamports have no mint.
#[event]
pub struct DepositSwept {
    pub merchant_id: [u8; 32],
    pub customer_ref: [u8; 32],
    pub mint: Pubkey,
    pub amount: u64,
    pub fee: u64,
}
