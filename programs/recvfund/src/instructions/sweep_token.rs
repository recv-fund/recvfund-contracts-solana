use anchor_lang::prelude::*;
use anchor_spl::associated_token::{self, AssociatedToken, Create};
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

use crate::errors::RecvFundError;
use crate::events::{DepositSwept, FeeRedirected};
use crate::fee::split;
use crate::state::{Merchant, DEPOSIT_SEED, MERCHANT_SEED};

#[derive(Accounts)]
#[instruction(customer_ref: [u8; 32])]
pub struct SweepToken<'info> {
    /// Merchant sweeper or admin. Also pays for missing destination ATAs and
    /// receives the rent from the closed deposit ATA.
    #[account(mut)]
    pub signer: Signer<'info>,

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

    /// CHECK: Pinned to the fee collector stored in this merchant's account at
    /// registration. The vendor config is not consulted, so a later change to
    /// the vendor's fee terms cannot redirect this merchant's fees.
    #[account(address = merchant.fee_collector)]
    pub fee_collector: UncheckedAccount<'info>,

    /// CHECK: The address is the collector's canonical ATA. Its token state is
    /// checked in the handler so a collector changing ATA authority cannot
    /// reject the merchant's entire sweep before fee redirection runs.
    #[account(
        mut,
        address = associated_token::get_associated_token_address(
            &fee_collector.key(), &mint.key()
        ),
    )]
    pub fee_collector_token_account: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Moves the whole token balance of one deposit address: `amount - fee` to
/// the merchant's settlement wallet and `fee` to the fee collector stored in
/// the merchant account, with `fee` computed at the merchant's stored
/// `fee_bps`. Both destinations are pinned by account constraints, so these
/// are the only places the deposit's funds can go. `merchant.is_active` is
/// not checked: deposits can always be swept.
pub fn sweep_token(ctx: Context<SweepToken>, customer_ref: [u8; 32]) -> Result<()> {
    let amount = ctx.accounts.deposit_token_account.amount;
    require!(amount > 0, RecvFundError::NothingToSweep);

    let (net, fee) = split(amount, ctx.accounts.merchant.fee_bps)?;

    // Create only an absent canonical collector ATA and only when a fee is
    // owed. Existing malformed, reassigned or frozen accounts redirect the
    // fee instead of becoming a vendor-controlled denial of service.
    let collector_account = ctx.accounts.fee_collector_token_account.to_account_info();
    if fee > 0
        && collector_account.owner == &anchor_lang::system_program::ID
        && collector_account.data_is_empty()
    {
        associated_token::create(CpiContext::new(
            ctx.accounts.associated_token_program.to_account_info(),
            Create {
                payer: ctx.accounts.signer.to_account_info(),
                associated_token: collector_account.clone(),
                authority: ctx.accounts.fee_collector.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        ))?;
    }
    let deliverable = fee == 0
        || (collector_account.owner == &token::ID
            && TokenAccount::try_deserialize(&mut collector_account.try_borrow_data()?.as_ref())
                .map(|account| {
                    account.mint == ctx.accounts.mint.key()
                        && account.owner == ctx.accounts.fee_collector.key()
                        && !account.is_frozen()
                })
                .unwrap_or(false));
    let (net, fee_paid) = if deliverable { (net, fee) } else { (amount, 0) };

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

    if fee_paid > 0 {
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
            fee_paid,
        )?;
    } else if fee > 0 {
        emit!(FeeRedirected {
            merchant_id: ctx.accounts.merchant.merchant_id,
            customer_ref,
            mint: ctx.accounts.mint.key(),
            fee,
        });
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
        fee: fee_paid,
    });
    Ok(())
}
