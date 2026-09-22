//! recv.fund settlement program.
//!
//! Funds move in exactly two ways: a payer's tokens go straight to the
//! merchant's settlement wallet (minus the fee) in `pay`, or a customer's
//! deposit is swept from a derived deposit address to the same settlement
//! wallet (minus the fee). No instruction accepts an arbitrary destination.

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
        fee_bps_checkout: u16,
        fee_bps_sweep: u16,
    ) -> Result<()> {
        instructions::initialize_config(ctx, fee_collector, fee_bps_checkout, fee_bps_sweep)
    }

    pub fn set_fees(ctx: Context<AuthorityOnly>, fee_bps_checkout: u16, fee_bps_sweep: u16) -> Result<()> {
        instructions::set_fees(ctx, fee_bps_checkout, fee_bps_sweep)
    }

    pub fn set_fee_collector(ctx: Context<AuthorityOnly>, new_fee_collector: Pubkey) -> Result<()> {
        instructions::set_fee_collector(ctx, new_fee_collector)
    }

    pub fn transfer_authority(ctx: Context<AuthorityOnly>, new_authority: Pubkey) -> Result<()> {
        instructions::transfer_authority(ctx, new_authority)
    }

    // ----- merchant self-service -----

    pub fn register_merchant(
        ctx: Context<RegisterMerchant>,
        merchant_id: [u8; 32],
        settlement_wallet: Pubkey,
    ) -> Result<()> {
        instructions::register_merchant(ctx, merchant_id, settlement_wallet)
    }

    pub fn set_settlement_wallet(ctx: Context<MerchantAdminOnly>, new_settlement_wallet: Pubkey) -> Result<()> {
        instructions::set_settlement_wallet(ctx, new_settlement_wallet)
    }

    pub fn set_sweeper(ctx: Context<MerchantAdminOnly>, new_sweeper: Pubkey) -> Result<()> {
        instructions::set_sweeper(ctx, new_sweeper)
    }

    pub fn set_merchant_active(ctx: Context<MerchantAdminOnly>, is_active: bool) -> Result<()> {
        instructions::set_merchant_active(ctx, is_active)
    }

    // ----- fund movement -----

    pub fn pay(ctx: Context<Pay>, invoice_id: [u8; 32], amount: u64) -> Result<()> {
        instructions::pay(ctx, invoice_id, amount)
    }

}
