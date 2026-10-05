use anchor_lang::prelude::*;

use crate::errors::RecvFundError;
use crate::events::FeeTermsUpdated;
use crate::state::{GlobalConfig, CONFIG_SEED, MAX_FEE_BPS};

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    // Bind bootstrap authority to this executable's real loader state, not
    // merely to whichever signer wins the first transaction after deployment.
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ RecvFundError::Unauthorized,
    )]
    pub program: Program<'info, crate::program::Recvfund>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(authority.key())
            @ RecvFundError::Unauthorized,
    )]
    pub program_data: Account<'info, ProgramData>,
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

fn validate_fee_terms(fee_collector: Pubkey, fee_bps: u16) -> Result<()> {
    require!(fee_bps <= MAX_FEE_BPS, RecvFundError::FeeTooHigh);
    require!(
        fee_collector != Pubkey::default(),
        RecvFundError::InvalidFeeCollector
    );
    Ok(())
}

pub fn initialize_config(
    ctx: Context<InitializeConfig>,
    fee_collector: Pubkey,
    fee_bps: u16,
) -> Result<()> {
    validate_fee_terms(fee_collector, fee_bps)?;

    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.authority.key();
    config.fee_collector = fee_collector;
    config.fee_bps = fee_bps;
    config.bump = ctx.bumps.config;

    emit!(FeeTermsUpdated {
        fee_collector,
        fee_bps
    });
    Ok(())
}

/// Shared context for every authority-only setter. The `has_one` check is the
/// only privilege the vendor holds. None of these setters references a token
/// account, a merchant account or a deposit address, so they cannot move funds
/// or change the terms of an existing merchant.
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

/// Sets the fee terms that `register_merchant` copies into merchants that
/// register after this call. Merchants already registered keep the terms in
/// their own account; this instruction does not and cannot touch them.
pub fn set_fee_terms(
    ctx: Context<AuthorityOnly>,
    fee_collector: Pubkey,
    fee_bps: u16,
) -> Result<()> {
    validate_fee_terms(fee_collector, fee_bps)?;
    let config = &mut ctx.accounts.config;
    config.fee_collector = fee_collector;
    config.fee_bps = fee_bps;
    emit!(FeeTermsUpdated {
        fee_collector,
        fee_bps
    });
    Ok(())
}

pub fn transfer_authority(ctx: Context<AuthorityOnly>, new_authority: Pubkey) -> Result<()> {
    ctx.accounts.config.authority = new_authority;
    Ok(())
}
