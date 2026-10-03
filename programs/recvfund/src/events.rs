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
