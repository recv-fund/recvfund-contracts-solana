use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

use crate::errors::RecvFundError;
use crate::events::DepositSwept;
use crate::fee::split;
use crate::state::{GlobalConfig, Merchant, CONFIG_SEED, DEPOSIT_SEED, MERCHANT_SEED};

#[derive(Accounts)]
#[instruction(customer_ref: [u8; 32])]
pub struct SweepToken<'info> {
    /// Merchant sweeper or admin. Also pays for missing destination ATAs and
    /// receives the rent from the closed deposit ATA.
    #[account(mut)]
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

    /// CHECK: Data-less PDA that owns the deposit ATA. Its authority over the
    /// ATA is exercised only here, with signer seeds, towards fixed destinations.
    #[account(seeds = [DEPOSIT_SEED, merchant.key().as_ref(), customer_ref.as_ref()], bump)]
    pub deposit_authority: UncheckedAccount<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = deposit_authority,
    )]
    pub deposit_token_account: Account<'info, TokenAccount>,

    /// CHECK: Pinned to the merchant's registered settlement wallet.
    #[account(address = merchant.settlement_wallet)]
    pub settlement_wallet: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = signer,
        associated_token::mint = mint,
        associated_token::authority = settlement_wallet,
    )]
    pub settlement_token_account: Account<'info, TokenAccount>,

    /// CHECK: Pinned to the fee collector in the vendor config.
    #[account(address = config.fee_collector)]
    pub fee_collector: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = signer,
        associated_token::mint = mint,
        associated_token::authority = fee_collector,
    )]
    pub fee_collector_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn sweep_token(ctx: Context<SweepToken>, customer_ref: [u8; 32]) -> Result<()> {
    let amount = ctx.accounts.deposit_token_account.amount;
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

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.deposit_token_account.to_account_info(),
                to: ctx.accounts.settlement_token_account.to_account_info(),
                authority: ctx.accounts.deposit_authority.to_account_info(),
            },
            signer_seeds,
        ),
        net,
    )?;

    if fee > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.deposit_token_account.to_account_info(),
                    to: ctx.accounts.fee_collector_token_account.to_account_info(),
                    authority: ctx.accounts.deposit_authority.to_account_info(),
                },
                signer_seeds,
            ),
            fee,
        )?;
    }

    // The ATA is empty now; closing returns its rent to whoever ran the sweep.
    // A later deposit recreates it at the same address, so nothing is lost.
    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.deposit_token_account.to_account_info(),
            destination: ctx.accounts.signer.to_account_info(),
            authority: ctx.accounts.deposit_authority.to_account_info(),
        },
        signer_seeds,
    ))?;

    emit!(DepositSwept {
        merchant_id: ctx.accounts.merchant.merchant_id,
        customer_ref,
        mint: ctx.accounts.mint.key(),
        amount,
        fee,
    });
    Ok(())
}
