use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

use crate::errors::RecvFundError;
use crate::events::{DepositSwept, FeeRedirected};
use crate::fee::split;
use crate::state::{Merchant, DEPOSIT_SEED, MERCHANT_SEED};

#[derive(Accounts)]
#[instruction(customer_ref: [u8; 32])]
pub struct SweepSol<'info> {
    pub signer: Signer<'info>,

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

    /// CHECK: Pinned to the fee collector stored in this merchant's account at
    /// registration. The vendor config is not consulted, so a later change to
    /// the vendor's fee terms cannot redirect this merchant's fees.
    #[account(mut, address = merchant.fee_collector)]
    pub fee_collector: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Moves the whole lamport balance of one deposit address: `amount - fee` to
/// the merchant's settlement wallet and `fee` to the fee collector stored in
/// the merchant account, with `fee` computed at the merchant's stored
/// `fee_bps`. Both destinations are pinned by account constraints, so these
/// are the only places the deposit's funds can go. `merchant.is_active` is
/// not checked: deposits can always be swept.
pub fn sweep_sol(ctx: Context<SweepSol>, customer_ref: [u8; 32]) -> Result<()> {
    let amount = ctx.accounts.deposit_authority.lamports();
    require!(amount > 0, RecvFundError::NothingToSweep);

    let (net, fee) = split(amount, ctx.accounts.merchant.fee_bps)?;

    // A transfer that leaves the collector below rent exemption fails, and
    // the vendor controls the collector's balance. Rather than let that block
    // the merchant's sweep, an undeliverable fee goes to the settlement wallet.
    let collector = ctx.accounts.fee_collector.to_account_info();
    let rent_minimum = Rent::get()?.minimum_balance(collector.data_len());
    let deliverable = fee == 0
        || (!collector.executable
            && collector
                .lamports()
                .checked_add(fee)
                .ok_or(RecvFundError::MathOverflow)?
                >= rent_minimum);
    let (net, fee_paid) = if deliverable { (net, fee) } else { (amount, 0) };

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

    if fee_paid > 0 {
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.deposit_authority.to_account_info(),
                    to: ctx.accounts.fee_collector.to_account_info(),
                },
                signer_seeds,
            ),
            fee_paid,
        )?;
    } else if fee > 0 {
        emit!(FeeRedirected {
            merchant_id: ctx.accounts.merchant.merchant_id,
            customer_ref,
            mint: Pubkey::default(),
            fee,
        });
    }

    emit!(DepositSwept {
        merchant_id: ctx.accounts.merchant.merchant_id,
        customer_ref,
        mint: Pubkey::default(),
        amount,
        fee: fee_paid,
    });
    Ok(())
}
