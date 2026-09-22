use anchor_lang::prelude::*;

#[event]
pub struct PaymentReceived {
    pub merchant_id: [u8; 32],
    pub invoice_id: [u8; 32],
    pub mint: Pubkey,
    pub amount: u64,
    pub fee: u64,
    pub payer: Pubkey,
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
