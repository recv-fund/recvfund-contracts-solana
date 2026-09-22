use anchor_lang::prelude::*;

#[error_code]
pub enum RecvFundError {
    #[msg("Fee rate exceeds the hard maximum of 200 bps")]
    FeeTooHigh,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Merchant is inactive and does not accept new payments")]
    MerchantInactive,
    #[msg("Signer is not authorized for this action")]
    Unauthorized,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Deposit balance is zero; nothing to sweep")]
    NothingToSweep,
    #[msg("Settlement wallet cannot be the default pubkey")]
    InvalidSettlementWallet,
}
