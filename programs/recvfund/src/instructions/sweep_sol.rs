use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

use crate::errors::RecvFundError;
use crate::events::DepositSwept;
use crate::fee::split;
use crate::state::{GlobalConfig, Merchant, CONFIG_SEED, DEPOSIT_SEED, MERCHANT_SEED};

#[derive(Accounts)]
#[instruction(customer_ref: [u8; 32])]
pub struct SweepSol<'info> {
    pub signer: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(
        seeds = [MERCHANT_SEED, merchant.merchant_id.as_ref()],
        bump = merchant.bump,
        constraint = signer.key() == merchant.sweeper || signer.key() == merchant.admin
            @ RecvFundError::Unauthorized,
    )]
    pub merchant: Account<'info, Merchant>,

    /// CHECK: Data-less, system-owned PDA holding the customer's lamports.
    /// The system program only lets us debit it because we sign with its seeds.
    #[account(mut, seeds = [DEPOSIT_SEED, merchant.key().as_ref(), customer_ref.as_ref()], bump)]
    pub deposit_authority: UncheckedAccount<'info>,

    /// CHECK: Pinned to the merchant's registered settlement wallet.
    #[account(mut, address = merchant.settlement_wallet)]
    pub settlement_wallet: UncheckedAccount<'info>,

    /// CHECK: Pinned to the fee collector in the vendor config.
    #[account(mut, address = config.fee_collector)]
    pub fee_collector: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn sweep_sol(ctx: Context<SweepSol>, customer_ref: [u8; 32]) -> Result<()> {
    let amount = ctx.accounts.deposit_authority.lamports();
    require!(amount > 0, RecvFundError::NothingToSweep);

    let (net, fee) = split(amount, ctx.accounts.config.fee_bps_sweep)?;

    let merchant_key = ctx.accounts.merchant.key();
    let bump = ctx.bumps.deposit_authority;
    let signer_seeds: &[&[&[u8]]] = &[&[
        DEPOSIT_SEED,
        merchant_key.as_ref(),
        customer_ref.as_ref(),
        &[bump],
    ]];

    system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.deposit_authority.to_account_info(),
                to: ctx.accounts.settlement_wallet.to_account_info(),
            },
            signer_seeds,
        ),
        net,
    )?;

    if fee > 0 {
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.deposit_authority.to_account_info(),
                    to: ctx.accounts.fee_collector.to_account_info(),
                },
                signer_seeds,
            ),
            fee,
        )?;
    }

    emit!(DepositSwept {
        merchant_id: ctx.accounts.merchant.merchant_id,
        customer_ref,
        mint: Pubkey::default(),
        amount,
        fee,
    });
    Ok(())
}
