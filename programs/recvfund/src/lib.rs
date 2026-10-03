//! recv.fund settlement program.
//!
//! Invariants:
//!
//! - The vendor is never in the payment path. Customers pay a per-customer
//!   deposit address derived from the merchant (`["deposit", merchant_pda,
//!   customer_ref]`). There is no checkout instruction; the program only
//!   acts when the merchant's sweeper or admin sweeps a deposit.
//! - Funds leave a deposit address in one way only, `sweep_token` or
//!   `sweep_sol`, and only to the merchant's settlement wallet and to the fee
//!   collector stored in that merchant's account. No instruction accepts an
//!   arbitrary destination.
//! - A merchant's fee terms (`fee_collector`, `fee_bps`) are copied from
//!   `GlobalConfig` at registration and no instruction changes them later.
//! - The vendor authority can change `GlobalConfig`, which affects only
//!   merchants registered afterwards. It cannot sign a sweep, cannot change a
//!   merchant account and cannot move funds.
//! - Every fee rate is capped at `MAX_FEE_BPS` (200 bps) on write and on use.

use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod fee;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("G9u3a8P6T5RFsgQhjVC5Yw7oAUqURst5MQJi1rFVkzAt");

#[program]
pub mod recvfund {
    use super::*;

    // ----- vendor configuration -----

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        fee_collector: Pubkey,
        fee_bps: u16,
    ) -> Result<()> {
        instructions::initialize_config(ctx, fee_collector, fee_bps)
    }

    pub fn set_fee_terms(
        ctx: Context<AuthorityOnly>,
        fee_collector: Pubkey,
        fee_bps: u16,
    ) -> Result<()> {
        instructions::set_fee_terms(ctx, fee_collector, fee_bps)
    }

    pub fn transfer_authority(ctx: Context<AuthorityOnly>, new_authority: Pubkey) -> Result<()> {
        instructions::transfer_authority(ctx, new_authority)
    }

    // ----- merchant self-service -----

    pub fn register_merchant(
        ctx: Context<RegisterMerchant>,
        merchant_id: [u8; 32],
        settlement_wallet: Pubkey,
        sweeper: Pubkey,
    ) -> Result<()> {
        instructions::register_merchant(ctx, merchant_id, settlement_wallet, sweeper)
    }

    pub fn set_settlement_wallet(
        ctx: Context<MerchantAdminOnly>,
        new_settlement_wallet: Pubkey,
    ) -> Result<()> {
        instructions::set_settlement_wallet(ctx, new_settlement_wallet)
    }

    pub fn set_sweeper(ctx: Context<MerchantAdminOnly>, new_sweeper: Pubkey) -> Result<()> {
        instructions::set_sweeper(ctx, new_sweeper)
    }

    pub fn set_merchant_active(ctx: Context<MerchantAdminOnly>, is_active: bool) -> Result<()> {
        instructions::set_merchant_active(ctx, is_active)
    }

    // ----- fund movement -----

    pub fn sweep_token(ctx: Context<SweepToken>, customer_ref: [u8; 32]) -> Result<()> {
        instructions::sweep_token(ctx, customer_ref)
    }

    pub fn sweep_sol(ctx: Context<SweepSol>, customer_ref: [u8; 32]) -> Result<()> {
        instructions::sweep_sol(ctx, customer_ref)
    }
}
