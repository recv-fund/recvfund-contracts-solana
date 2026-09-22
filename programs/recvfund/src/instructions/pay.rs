use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::errors::RecvFundError;
use crate::events::PaymentReceived;
use crate::fee::split;
use crate::state::{GlobalConfig, Invoice, Merchant, CONFIG_SEED, INVOICE_SEED, MERCHANT_SEED};

#[derive(Accounts)]
#[instruction(invoice_id: [u8; 32])]
pub struct Pay<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(
        seeds = [MERCHANT_SEED, merchant.merchant_id.as_ref()],
        bump = merchant.bump,
    )]
    pub merchant: Account<'info, Merchant>,

    /// Receipt. `init` (not `init_if_needed`) is what rejects a second payment
    /// for the same invoice.
    #[account(
        init,
        payer = payer,
        space = 8 + Invoice::INIT_SPACE,
        seeds = [INVOICE_SEED, merchant.key().as_ref(), invoice_id.as_ref()],
        bump,
    )]
    pub invoice: Account<'info, Invoice>,

    pub mint: Account<'info, Mint>,

    /// The token program enforces that `payer` owns or is delegate of this
    /// account when it signs the transfer; the mint check is ours.
    #[account(mut, constraint = payer_token_account.mint == mint.key())]
    pub payer_token_account: Account<'info, TokenAccount>,

    /// CHECK: Pinned to the merchant's registered settlement wallet. It is only
    /// used as the ATA authority below, so no further validation is needed.
    #[account(address = merchant.settlement_wallet)]
    pub settlement_wallet: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = settlement_wallet,
    )]
    pub settlement_token_account: Account<'info, TokenAccount>,

    /// CHECK: Pinned to the fee collector in the vendor config.
    #[account(address = config.fee_collector)]
    pub fee_collector: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = fee_collector,
    )]
    pub fee_collector_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn pay(ctx: Context<Pay>, invoice_id: [u8; 32], amount: u64) -> Result<()> {
    require!(amount > 0, RecvFundError::ZeroAmount);
    require!(
        ctx.accounts.merchant.is_active,
        RecvFundError::MerchantInactive
    );

    let (net, fee) = split(amount, ctx.accounts.config.fee_bps_checkout)?;

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.payer_token_account.to_account_info(),
                to: ctx.accounts.settlement_token_account.to_account_info(),
                authority: ctx.accounts.payer.to_account_info(),
            },
        ),
        net,
    )?;

    // Small amounts round the fee to zero; skip the CPI rather than move 0.
    if fee > 0 {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.payer_token_account.to_account_info(),
                    to: ctx.accounts.fee_collector_token_account.to_account_info(),
                    authority: ctx.accounts.payer.to_account_info(),
                },
            ),
            fee,
        )?;
    }

    let invoice = &mut ctx.accounts.invoice;
    invoice.merchant = ctx.accounts.merchant.key();
    invoice.invoice_id = invoice_id;
    invoice.mint = ctx.accounts.mint.key();
    invoice.payer = ctx.accounts.payer.key();
    invoice.amount = amount;
    invoice.fee = fee;
    invoice.paid_at = Clock::get()?.unix_timestamp;
    invoice.bump = ctx.bumps.invoice;

    emit!(PaymentReceived {
        merchant_id: ctx.accounts.merchant.merchant_id,
        invoice_id,
        mint: ctx.accounts.mint.key(),
        amount,
        fee,
        payer: ctx.accounts.payer.key(),
    });
    Ok(())
}
