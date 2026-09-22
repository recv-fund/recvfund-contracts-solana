use anchor_lang::prelude::*;

use crate::errors::RecvFundError;
use crate::state::{GlobalConfig, CONFIG_SEED, MAX_FEE_BPS};

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + GlobalConfig::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, GlobalConfig>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_config(
    ctx: Context<InitializeConfig>,
    fee_collector: Pubkey,
    fee_bps_checkout: u16,
    fee_bps_sweep: u16,
) -> Result<()> {
    require!(fee_bps_checkout <= MAX_FEE_BPS, RecvFundError::FeeTooHigh);
    require!(fee_bps_sweep <= MAX_FEE_BPS, RecvFundError::FeeTooHigh);

    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.authority.key();
    config.fee_collector = fee_collector;
    config.fee_bps_checkout = fee_bps_checkout;
    config.fee_bps_sweep = fee_bps_sweep;
    config.bump = ctx.bumps.config;
    Ok(())
}

/// Shared context for every authority-only setter. The `has_one` check is the
/// only privilege the vendor holds; none of these setters can reference a
/// token account or a merchant, so they cannot move funds.
#[derive(Accounts)]
pub struct AuthorityOnly<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ RecvFundError::Unauthorized,
    )]
    pub config: Account<'info, GlobalConfig>,
}

pub fn set_fees(ctx: Context<AuthorityOnly>, fee_bps_checkout: u16, fee_bps_sweep: u16) -> Result<()> {
    require!(fee_bps_checkout <= MAX_FEE_BPS, RecvFundError::FeeTooHigh);
    require!(fee_bps_sweep <= MAX_FEE_BPS, RecvFundError::FeeTooHigh);
    let config = &mut ctx.accounts.config;
    config.fee_bps_checkout = fee_bps_checkout;
    config.fee_bps_sweep = fee_bps_sweep;
    Ok(())
}

pub fn set_fee_collector(ctx: Context<AuthorityOnly>, new_fee_collector: Pubkey) -> Result<()> {
    ctx.accounts.config.fee_collector = new_fee_collector;
    Ok(())
}

pub fn transfer_authority(ctx: Context<AuthorityOnly>, new_authority: Pubkey) -> Result<()> {
    ctx.accounts.config.authority = new_authority;
    Ok(())
}
