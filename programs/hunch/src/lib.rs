//! Hunch, version one, the curve phase.
//!
//! A program holding a tiny network (`hunch-net`, 10-8-8-1, 169 integer weights) that learns from its
//! coin's own Meteora DBC pool and spends a fee budget only on buying HUNCH from that pool and burning it.
//!
//! - `tick` (anyone, first 30 seconds of each 10-minute bar, top level and alone): reads the pool's
//!   sqrt_price and fee counters, takes Hunch's own buys out, trains on the sample from 6 bars ago,
//!   thinks, stores the bar. At the first bar of each UTC hour it also scores the hour that ended
//!   (forfeits for missed boundaries; no call, so a forfeit, when a tick in the 5 bars before the
//!   boundary was missed), makes the hour's call (the open call account), writes the diary
//!   entry and its memo line; at the first tick of each UTC day, the brain record.
//! - `buy_and_burn_curve` (anyone, once per UTC hour after its boundary tick): sync_native, claim the
//!   creator fee, slice = held / 6 x m, floor, three caps, guard, swap with a min_out of 99% of its own
//!   quote, a post-swap price check, burn everything. Or it waits and records why: once per hour, since
//!   a further call that would wait again fails (one that can buy is still allowed).
//! - `adopt_curve` (the DBC config may carry the first-swap-with-min-fee flag: DBC grants that fee only
//!   to the first swap inside the pool-creating transaction, the developer's optional buy),
//!   `initialize` (also sets the coin's ticker, which the diary line names), `load_brain`,
//!   `claim_curve_fees`, `read_call`, `grow_brain_book`.
//!
//! Graduation (the pool phase, Meteora DAMM v2):
//! - `withdraw_surplus` (anyone, once the curve is complete): DBC creator_withdraw_surplus into the budget.
//! - `adopt_pool` (anyone, once the DBC pool reports migrated): only the DAMM v2 pool DBC's migration made
//!   (a config only DBC's pool authority can use, the address DAMM v2 derives from it and the two mints,
//!   the creator, fees in SOL) and Hunch's position in it (its Token-2022 NFT held by the budget, locked for
//!   good at least 25% of the liquidity DBC's migration builds from the threshold and migration price
//!   adopt_curve pinned, so no outside liquidity can block it). Keeps the curve's record, starts the pool's
//!   after a 2-hour warm-up; the first boundary after it writes the graduation line.
//! - `tick` then reads the DAMM v2 pool: sqrt_price, total_lp_b_fee + total_protocol_b_fee, liquidity,
//!   status and the fee fields; an hour in which Meteora changed the fee (or set one Hunch cannot model)
//!   or paused the pool, or the hour it is measured against, is not scored.
//! - `claim_pool_fees` (anyone): DAMM v2 claim_position_fee, the budget signing as the NFT owner.
//! - `buy_and_burn_pool`: buy_and_burn_curve's rules on DAMM v2 swap2 (refused while paused, and while the
//!   fee is above the fee at adoption or one Hunch cannot model; the impact cap on the smaller of the last
//!   tick's and the live liquidity), burning DBC's leftover HUNCH too.
//!
//! The developer's withdrawal (added 2026-10-20), `withdraw_budget` (the program's upgrade authority only,
//! top level, never by CPI, in the curve, graduating or pool phase): claims the fee owed to the budget as the
//! hourly buy does, then moves the budget's WSOL (all of it, or an amount) to a WSOL account the signer owns.
//! The developer says they use it to buy the coin and burn it by hand. It records a lifetime total and a
//! count in State (`withdrawn`, `withdrawals`, `last_withdraw_hour`), an event and a memo line, and changes
//! nothing the hourly buy decides by: that buy goes on with whatever fee arrives later.
//!
//! The program stays upgradeable (the developer's upgrade authority). The rules are mirrored one for one
//! in `hunch/site/core/chain.js`, and the LiteSVM replay checks the two agree on every tick.

#![cfg_attr(target_os = "solana", no_std)]

pub mod format;
pub mod ids;
pub mod layout;
pub mod rules;
pub mod u256;

#[cfg(target_os = "solana")]
pub mod processor;

#[cfg(target_os = "solana")]
mod entrypoint {
    pinocchio::program_entrypoint!(crate::processor::process_instruction);
    pinocchio::no_allocator!();
    pinocchio::nostd_panic_handler!();
}
