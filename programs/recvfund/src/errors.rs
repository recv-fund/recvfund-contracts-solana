use anchor_lang::prelude::*;

#[error_code]
pub enum RecvFundError {
    #[msg("Fee rate exceeds the hard maximum of 200 bps")]
    FeeTooHigh,
    #[msg("Signer is not authorized for this action")]
    Unauthorized,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Deposit balance is zero; nothing to sweep")]
    NothingToSweep,
    #[msg("Settlement wallet cannot be the default pubkey")]
    InvalidSettlementWallet,
    #[msg("Fee collector cannot be the default pubkey")]
    InvalidFeeCollector,
}
