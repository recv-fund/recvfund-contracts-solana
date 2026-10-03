use anchor_lang::prelude::*;

use crate::errors::RecvFundError;
use crate::state::{BPS_DENOMINATOR, MAX_FEE_BPS};

/// Fee on `amount` at `bps`, rounded down. u128 intermediates so that
/// `amount * bps` cannot overflow for any u64 amount.
pub fn compute_fee(amount: u64, bps: u16) -> Result<u64> {
    require!(bps <= MAX_FEE_BPS, RecvFundError::FeeTooHigh);
    let fee = (amount as u128)
        .checked_mul(bps as u128)
        .ok_or(RecvFundError::MathOverflow)?
        .checked_div(BPS_DENOMINATOR)
        .ok_or(RecvFundError::MathOverflow)?;
    u64::try_from(fee).map_err(|_| RecvFundError::MathOverflow.into())
}

/// Returns `(net, fee)` for `amount` at `bps`.
pub fn split(amount: u64, bps: u16) -> Result<(u64, u64)> {
    let fee = compute_fee(amount, bps)?;
    let net = amount.checked_sub(fee).ok_or(RecvFundError::MathOverflow)?;
    Ok((net, fee))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_down() {
        assert_eq!(compute_fee(999, 100).unwrap(), 9);
        assert_eq!(compute_fee(1, 200).unwrap(), 0);
        assert_eq!(compute_fee(10_000, 200).unwrap(), 200);
    }

    #[test]
    fn zero_rate_takes_no_fee() {
        assert_eq!(split(u64::MAX, 0).unwrap(), (u64::MAX, 0));
        assert_eq!(split(1, 0).unwrap(), (1, 0));
    }

    #[test]
    fn handles_u64_max_without_overflow() {
        let (net, fee) = split(u64::MAX, MAX_FEE_BPS).unwrap();
        assert_eq!(net + fee, u64::MAX);
    }

    #[test]
    fn rejects_rate_above_cap() {
        assert!(compute_fee(1, MAX_FEE_BPS + 1).is_err());
    }
}
