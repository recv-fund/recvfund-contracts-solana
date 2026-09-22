use anchor_lang::prelude::*;

use crate::errors::RecvFundError;
use crate::state::{Merchant, MERCHANT_SEED};

#[derive(Accounts)]
#[instruction(merchant_id: [u8; 32])]
pub struct RegisterMerchant<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Merchant::INIT_SPACE,
        seeds = [MERCHANT_SEED, merchant_id.as_ref()],
        bump,
    )]
    pub merchant: Account<'info, Merchant>,
    pub system_program: Program<'info, System>,
}

/// Anyone can register: merchants run their own server and are not vetted by
/// the vendor. The merchant PDA is keyed by `merchant_id`, so a second
/// registration under the same id fails at account creation.
pub fn register_merchant(
    ctx: Context<RegisterMerchant>,
    merchant_id: [u8; 32],
    settlement_wallet: Pubkey,
) -> Result<()> {
    require!(
        settlement_wallet != Pubkey::default(),
        RecvFundError::InvalidSettlementWallet
    );
    let merchant = &mut ctx.accounts.merchant;
    merchant.merchant_id = merchant_id;
    merchant.admin = ctx.accounts.admin.key();
    merchant.settlement_wallet = settlement_wallet;
    merchant.sweeper = ctx.accounts.admin.key();
    merchant.is_active = true;
    merchant.bump = ctx.bumps.merchant;
    Ok(())
}

/// Shared context for every merchant-admin-only setter.
#[derive(Accounts)]
pub struct MerchantAdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [MERCHANT_SEED, merchant.merchant_id.as_ref()],
        bump = merchant.bump,
        has_one = admin @ RecvFundError::Unauthorized,
    )]
    pub merchant: Account<'info, Merchant>,
}

pub fn set_settlement_wallet(
    ctx: Context<MerchantAdminOnly>,
    new_settlement_wallet: Pubkey,
) -> Result<()> {
    require!(
        new_settlement_wallet != Pubkey::default(),
        RecvFundError::InvalidSettlementWallet
    );
    ctx.accounts.merchant.settlement_wallet = new_settlement_wallet;
    Ok(())
}

pub fn set_sweeper(ctx: Context<MerchantAdminOnly>, new_sweeper: Pubkey) -> Result<()> {
    ctx.accounts.merchant.sweeper = new_sweeper;
    Ok(())
}

/// Inactive merchants reject new `pay` calls only. Sweeps stay enabled so
/// that funds already sitting in deposit addresses are never trapped.
pub fn set_merchant_active(ctx: Context<MerchantAdminOnly>, is_active: bool) -> Result<()> {
    ctx.accounts.merchant.is_active = is_active;
    Ok(())
}
