//! Account layouts: Hunch's own accounts and the fields it reads from Meteora DBC's accounts.
//! Everything is little-endian at fixed offsets; `State` and the model are `repr(C)` integer structs
//! used in place (their sizes are asserted below).

use hunch_net::Model;

/// Account tags (the first 8 bytes of each of Hunch's accounts).
pub const STATE_TAG: [u8; 8] = *b"HUNCHSTA";
pub const MODEL_TAG: [u8; 8] = *b"HUNCHMDL";
pub const TAPE_TAG: [u8; 8] = *b"HUNCHTAP";
pub const SIGNAL_TAG: [u8; 8] = *b"HUNCHCAL";
pub const DIARY_TAG: [u8; 8] = *b"HUNCHDRY";
pub const BOOK_TAG: [u8; 8] = *b"HUNCHBRN";

/// The program's state, PDA `["state"]`.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct State {
    pub tag: [u8; 8],
    pub version: u8,
    pub phase: u8,
    pub chapter: u8,
    /// 0 the fixed seed, 1 a brain loaded by load_brain.
    pub brain_source: u8,
    pub budget_bump: u8,
    pub event_bump: u8,
    pub last_outcome: u8,
    pub blind: u8,
    pub mint: [u8; 32],
    pub pool: [u8; 32],
    pub config: [u8; 32],
    pub base_vault: [u8; 32],
    pub quote_vault: [u8; 32],
    pub budget: [u8; 32],
    pub budget_wsol: [u8; 32],
    pub budget_hunch: [u8; 32],
    pub model: [u8; 32],
    pub tape: [u8; 32],
    pub signal: [u8; 32],
    pub diary: [u8; 32],
    pub book: [u8; 32],
    pub event_authority: [u8; 32],
    /// SHA-256 of the starting weights (the seed's, or the loaded brain's).
    pub brain_hash: [u8; 32],
    pub seed: u32,
    pub launch_hour: u32,
    pub launch_ts: i64,
    pub activation_point: u64,
    /// The pool's fee schedule and migration threshold, pinned from the config at adoption.
    pub cliff_fee: u64,
    pub reduction: u64,
    pub period_frequency: u64,
    pub n_periods: u64,
    pub migration_quote_threshold: u64,
    // ---- tick ----
    pub ticks: u64,
    pub last_tick_ts: i64,
    pub last_tick_bar: u32,
    pub start_hour: u32,
    pub last_sp: [u64; 2],
    pub last_fee_total: u64,
    /// Cumulative outside volume in lamports (fee counters minus Hunch's own, divided by the live fee).
    pub cum: u64,
    /// Hunch's own fee, price move (Q32.32 sqrt ratio) and lamports spent since the last tick.
    pub own_fee: u64,
    pub own_ratio: u64,
    pub own_lamports: u64,
    /// The last bar that had a tick attempt (blind ticks included): once per bar.
    pub last_attempt_bar: u32,
    /// Hours up to this one are not scored (they were blind).
    pub blind_until_hour: u32,
    // ---- scoring ----
    pub last_boundary_hour: u32,
    pub recent_len: u32,
    pub last_boundary_ts: i64,
    pub last_boundary_cum: u64,
    pub ref_vol: u64,
    pub ref_secs: u64,
    /// The previous hour's outside volume as a one-hour figure (the 25% cap).
    pub hour_vol_prev: u64,
    pub recent_bits: u32,
    /// UTC day number + 1 of the last brain record (0 none).
    pub last_record_day: u32,
    pub n: u32,
    pub hits: u32,
    pub rule_hits: u32,
    pub busier_hours: u32,
    pub quieter_calls: u32,
    pub quieter_hits: u32,
    pub forfeits: u32,
    pub not_scored: u32,
    // ---- buy ----
    pub last_buy_hour: u32,
    /// UTC day number + 1 of the daily counters (0 none).
    pub buy_day: u32,
    pub last_buy_ts: i64,
    pub day_buys: u32,
    pub hs_reason: u8,
    pub hs_detail: u8,
    pub pad0: [u8; 2],
    pub day_spent: u64,
    pub day_cap: u64,
    /// The last buy attempt of the hour `hs_hour`: what it bought and burned, or why it waited.
    pub hs_hour: u32,
    pub pad1: u32,
    pub hs_bought: u64,
    pub hs_burned: u64,
    pub hs_held: u64,
    pub spent: u64,
    pub bought_units: u64,
    pub burned: u64,
    pub donated: u64,
    pub buys: u32,
    pub skips: u32,
    pub claimed: u64,
    /// The latest bar whose tick was missed (0 none): a call needs the 5 bars before it landed.
    pub last_missed_bar: u32,
    pub pad2: u32,
    // ---- graduation and the pool phase (Meteora DAMM v2) ----
    /// The DAMM v2 pool DBC's migration made, its config, vaults, and Hunch's position (and its NFT).
    pub damm_pool: [u8; 32],
    pub damm_config: [u8; 32],
    pub token_a_vault: [u8; 32],
    pub token_b_vault: [u8; 32],
    pub position: [u8; 32],
    pub position_nft: [u8; 32],
    pub position_mint: [u8; 32],
    /// The pool's liquidity at the last landed tick (the impact cap takes the smaller of it and the live one).
    pub last_liquidity: [u64; 2],
    /// The fee configuration at adoption and at the last tick (first 8 bytes of a SHA-256 of the fee fields).
    pub adopt_fee_fp: u64,
    pub last_fee_fp: u64,
    /// The live fee numerator at adoption.
    pub adopt_fee_num: u64,
    /// What creator_withdraw_surplus paid into the budget, and what the position's fee claims paid.
    pub surplus: u64,
    pub pool_claimed: u64,
    pub adopt_ts: i64,
    pub adopt_hour: u32,
    /// Hours before this one are not owed a score in the pool phase (the 2-hour warm-up after adoption).
    pub pool_warm_end: u32,
    /// The curve phase's record, kept when the pool phase starts its own.
    pub prev_n: u32,
    pub prev_hits: u32,
    pub prev_rule_hits: u32,
    pub prev_forfeits: u32,
    pub prev_not_scored: u32,
    /// The pool's status at the last tick (0 trading, 1 paused by Meteora).
    pub last_status: u8,
    /// What Meteora did in the boundary interval being measured (dist_cur) and in the one before it
    /// (dist_prev), as bits: 1 the fee changed (or is not one Hunch can model), 2 the pool was paused.
    pub dist_cur: u8,
    pub dist_prev: u8,
    /// 1 while the graduation line is still to be written by the next boundary tick.
    pub grad_line: u8,
    /// The coin's ticker, set once by initialize: 1 to 10 characters A-Z and 0-9, zero-padded (the first
    /// zero byte ends it). The diary line names it ("burned 1.20M HUNCH.").
    pub ticker: [u8; 16],
    /// The DBC config's migration_sqrt_price (u128, low word first), pinned by adopt_curve. adopt_pool
    /// measures Hunch's position against the liquidity DBC's migration builds from it and
    /// migration_quote_threshold.
    pub migration_sqrt_price: [u64; 2],
    pub reserved: [u64; 4],
}

pub const STATE_LEN: usize = core::mem::size_of::<State>();
const _: () = assert!(STATE_LEN % 8 == 0);
const _: () = assert!(core::mem::align_of::<State>() == 8);

/// The longest ticker initialize accepts.
pub const TICKER_MAX: usize = 10;

/// A ticker initialize accepts: 1 to 10 characters, A-Z and 0-9 only.
pub fn ticker_ok(t: &[u8]) -> bool {
    !t.is_empty() && t.len() <= TICKER_MAX && t.iter().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

/// The ticker stored in the state (up to its first zero byte).
pub fn ticker_of(st: &State) -> &[u8] {
    let n = st.ticker.iter().position(|b| *b == 0).unwrap_or(st.ticker.len());
    &st.ticker[..n]
}

/// The model account: tag, then the network and its feature tape in place.
pub const MODEL_OFFSET: usize = 8;
pub const MODEL_LEN: usize = MODEL_OFFSET + core::mem::size_of::<Model>();
const _: () = assert!(core::mem::size_of::<Model>() % 8 == 0);

/// Weights of the model account (first in `Model`): 169 i32 then a pad i32.
pub const WEIGHTS_OFFSET: usize = MODEL_OFFSET;

/// The tape: header (tag, head u32, count u32, reserved u64) then 144 bars of 48 bytes.
pub const TAPE_HEADER: usize = 24;
pub const TAPE_ENTRIES: usize = 144;
pub const TAPE_ENTRY: usize = 48;
pub const TAPE_LEN: usize = TAPE_HEADER + TAPE_ENTRIES * TAPE_ENTRY;

/// The open call, 160 bytes at the offsets the design publishes.
pub const SIGNAL_LEN: usize = 160;
pub mod sig {
    pub const VERSION: usize = 8;
    pub const PHASE: usize = 9;
    pub const CALL: usize = 10;
    pub const CHAPTER: usize = 11;
    pub const LEAN: usize = 12;
    pub const LAST_OUTCOME: usize = 14;
    pub const FLAGS: usize = 15;
    pub const HOURS: usize = 16;
    pub const UNIX_HOUR: usize = 20;
    pub const MADE_SLOT: usize = 24;
    pub const N: usize = 32;
    pub const HITS: usize = 36;
    pub const RULE_HITS: usize = 40;
    pub const BUSIER_HOURS: usize = 44;
    pub const QUIETER_CALLS: usize = 48;
    pub const QUIETER_HITS: usize = 52;
    pub const FORFEITS: usize = 56;
    pub const LUCK_BAND: usize = 60;
    pub const MULT: usize = 62;
    pub const BRAIN: usize = 64;
    pub const BUDGET: usize = 72;
    pub const PLANNED_SLICE: usize = 80;
    pub const SPENT: usize = 88;
    pub const BURNED: usize = 96;
    pub const BUYS: usize = 104;
    pub const SKIPS: usize = 108;
    pub const POOL_FEE_BPS: usize = 112;
    pub const POOL_STATUS: usize = 114;
    pub const PREV_N: usize = 116;
    pub const PREV_HITS: usize = 120;
    pub const PREV_RULE_HITS: usize = 124;
    /// The one-line rule's call for this hour.
    pub const RULE: usize = 128;
    /// What the last scored hour came out as (1 quieter, 2 busier).
    pub const CAME: usize = 129;
    pub const NOT_SCORED: usize = 132;
}

/// The diary: header (tag, head u32, count u32, total u64) then 144 entries of 64 bytes.
pub const DIARY_HEADER: usize = 24;
pub const DIARY_ENTRIES: usize = 144;
pub const DIARY_ENTRY: usize = 64;
pub const DIARY_LEN: usize = DIARY_HEADER + DIARY_ENTRIES * DIARY_ENTRY;

/// The brain book: header (tag, launch day u32, capacity u32, written u32, reserved) then records
/// of 64 bytes indexed by the UTC day since launch. Created with 92 records, grown 92 at a time.
pub const BOOK_HEADER: usize = 32;
pub const BOOK_RECORD: usize = 64;
pub const BOOK_STEP: usize = 92;
pub const BOOK_INITIAL_LEN: usize = BOOK_HEADER + BOOK_STEP * BOOK_RECORD;
/// grow_brain_book is refused while more than this many free records remain.
pub const BOOK_GROW_BELOW: usize = 30;

/// Meteora DBC VirtualPool (8-byte discriminator + 416 bytes), DBC 0.2.1 source `state/virtual_pool.rs`.
pub mod pool {
    pub const LEN: usize = 424;
    pub const CONFIG: usize = 72;
    pub const CREATOR: usize = 104;
    pub const BASE_MINT: usize = 136;
    pub const BASE_VAULT: usize = 168;
    pub const QUOTE_VAULT: usize = 200;
    pub const BASE_RESERVE: usize = 232;
    pub const QUOTE_RESERVE: usize = 240;
    pub const SQRT_PRICE: usize = 280;
    pub const ACTIVATION_POINT: usize = 296;
    pub const POOL_TYPE: usize = 304;
    pub const IS_MIGRATED: usize = 305;
    /// 0 pre-bonding, 1 post-bonding, 2 locked vesting, 3 created pool (migrated).
    pub const MIGRATION_PROGRESS: usize = 308;
    pub const MIGRATION_CREATED_POOL: u8 = 3;
    /// metrics.total_protocol_quote_fee
    pub const TOTAL_PROTOCOL_QUOTE_FEE: usize = 320;
    /// metrics.total_trading_quote_fee
    pub const TOTAL_TRADING_QUOTE_FEE: usize = 336;
    pub const CREATOR_QUOTE_FEE: usize = 360;
}

/// Meteora DBC PoolConfig (8-byte discriminator + 1,040 bytes), DBC 0.2.1 source `state/config.rs`.
pub mod config {
    pub const LEN: usize = 1048;
    pub const QUOTE_MINT: usize = 8;
    pub const FEE_CLAIMER: usize = 40;
    pub const LEFTOVER_RECEIVER: usize = 72;
    // pool_fees.base_fee
    pub const CLIFF_FEE_NUMERATOR: usize = 104;
    /// period_frequency
    pub const SECOND_FACTOR: usize = 112;
    /// reduction_factor
    pub const THIRD_FACTOR: usize = 120;
    /// number_of_period
    pub const FIRST_FACTOR: usize = 128;
    pub const BASE_FEE_MODE: usize = 130;
    /// pool_fees.dynamic_fee.initialized
    pub const DYNAMIC_FEE_INITIALIZED: usize = 136;
    pub const PARTNER_VESTING_INITIALIZED: usize = 184;
    pub const CREATOR_VESTING_INITIALIZED: usize = 200;
    pub const COLLECT_FEE_MODE: usize = 232;
    pub const MIGRATION_OPTION: usize = 233;
    pub const ACTIVATION_TYPE: usize = 234;
    pub const TOKEN_DECIMAL: usize = 235;
    pub const TOKEN_TYPE: usize = 237;
    pub const QUOTE_TOKEN_FLAG: usize = 238;
    pub const PARTNER_LOCKED_PCT: usize = 239;
    pub const PARTNER_LIQUIDITY_PCT: usize = 240;
    pub const CREATOR_LOCKED_PCT: usize = 241;
    pub const CREATOR_LIQUIDITY_PCT: usize = 242;
    pub const MIGRATION_FEE_OPTION: usize = 243;
    pub const CREATOR_TRADING_FEE_PCT: usize = 245;
    pub const TOKEN_UPDATE_AUTHORITY: usize = 246;
    pub const MIGRATION_FEE_PCT: usize = 247;
    pub const CREATOR_MIGRATION_FEE_PCT: usize = 248;
    pub const MIGRATION_QUOTE_THRESHOLD: usize = 264;
    pub const MIGRATION_SQRT_PRICE: usize = 280;
    /// locked_vesting_config.amount_per_period and .cliff_unlock_amount
    pub const VESTING_AMOUNT_PER_PERIOD: usize = 296;
    pub const VESTING_CLIFF_UNLOCK: usize = 328;
    pub const MIGRATED_COLLECT_FEE_MODE: usize = 360;
    pub const MIGRATED_DYNAMIC_FEE: usize = 361;
    pub const MIGRATED_POOL_FEE_BPS: usize = 362;
    pub const MIGRATED_POOL_BASE_FEE_MODE: usize = 364;
    pub const ENABLE_FIRST_SWAP_WITH_MIN_FEE: usize = 365;
    pub const MIGRATED_COMPOUNDING_FEE_BPS: usize = 366;
    pub const POOL_CREATION_FEE: usize = 368;
    pub const SQRT_START_PRICE: usize = 392;
    pub const CURVE: usize = 408;
    pub const CURVE_POINTS: usize = 20;
}

/// Meteora DAMM v2 Pool (8-byte discriminator + 1,104 bytes), cp-amm `state/pool.rs`; the offsets are
/// checked against a pool that DBC's mainnet bytecode migrated into DAMM v2's mainnet bytecode (LiteSVM).
pub mod damm {
    pub const LEN: usize = 1112;
    // pool_fees (160 bytes from 8): base_fee.base_fee_info.data [8..40]
    pub const CLIFF_FEE_NUMERATOR: usize = 8;
    pub const BASE_FEE_MODE: usize = 16;
    pub const NUMBER_OF_PERIOD: usize = 22;
    pub const PERIOD_FREQUENCY: usize = 24;
    pub const REDUCTION_FACTOR: usize = 32;
    /// protocol_fee_percent, referral_fee_percent and compounding_fee_bps sit in [48..56]
    pub const FEE_SPLIT: usize = 48;
    pub const DYNAMIC_FEE_INITIALIZED: usize = 56;
    /// max_volatility_accumulator u32, variable_fee_control u32, bin_step u16, filter u16, decay u16, reduction u16
    pub const DYNAMIC_FEE_PARAMS: usize = 64;
    pub const VARIABLE_FEE_CONTROL: usize = 68;
    pub const BIN_STEP: usize = 72;
    pub const VOLATILITY_ACCUMULATOR: usize = 120;
    pub const TOKEN_A_MINT: usize = 168;
    pub const TOKEN_B_MINT: usize = 200;
    pub const TOKEN_A_VAULT: usize = 232;
    pub const TOKEN_B_VAULT: usize = 264;
    pub const LIQUIDITY: usize = 360;
    pub const SQRT_MIN_PRICE: usize = 424;
    pub const SQRT_MAX_PRICE: usize = 440;
    pub const SQRT_PRICE: usize = 456;
    pub const ACTIVATION_TYPE: usize = 480;
    pub const POOL_STATUS: usize = 481;
    pub const COLLECT_FEE_MODE: usize = 484;
    pub const FEE_VERSION: usize = 486;
    pub const PERMANENT_LOCK_LIQUIDITY: usize = 552;
    /// metrics.total_lp_b_fee (u128) and metrics.total_protocol_b_fee (u64)
    pub const TOTAL_LP_B_FEE: usize = 584;
    pub const TOTAL_PROTOCOL_B_FEE: usize = 608;
    pub const CREATOR: usize = 648;
    pub const TOKEN_B_AMOUNT: usize = 688;
    /// CollectFeeMode::OnlyB: every fee is in token B (SOL), on the way in for a buy and out for a sale.
    pub const ONLY_B: u8 = 1;
    /// BaseFeeMode::FeeTimeSchedulerLinear and ...Exponential.
    pub const MODE_TIME_LINEAR: u8 = 0;
    pub const MODE_TIME_EXPONENTIAL: u8 = 1;
}

/// The fee fields of a DAMM v2 pool account (its live volatility accumulator included).
pub fn damm_fee_of(d: &[u8]) -> crate::rules::DammFee {
    use damm as o;
    crate::rules::DammFee {
        cliff: rd_u64(d, o::CLIFF_FEE_NUMERATOR),
        mode: d[o::BASE_FEE_MODE],
        n_periods: rd_u16(d, o::NUMBER_OF_PERIOD),
        frequency: rd_u64(d, o::PERIOD_FREQUENCY),
        reduction: rd_u64(d, o::REDUCTION_FACTOR),
        dynamic: d[o::DYNAMIC_FEE_INITIALIZED] != 0,
        volatility_accumulator: rd_u128(d, o::VOLATILITY_ACCUMULATOR),
        bin_step: rd_u16(d, o::BIN_STEP),
        variable_fee_control: rd_u32(d, o::VARIABLE_FEE_CONTROL),
        fee_version: d[o::FEE_VERSION],
    }
}

/// Meteora DAMM v2 Position (8 + 400 bytes), cp-amm `state/position.rs`.
pub mod position {
    pub const LEN: usize = 408;
    pub const POOL: usize = 8;
    pub const NFT_MINT: usize = 40;
    pub const UNLOCKED_LIQUIDITY: usize = 152;
    pub const VESTED_LIQUIDITY: usize = 168;
    pub const PERMANENT_LOCKED_LIQUIDITY: usize = 184;
}

/// Meteora DAMM v2 Config (8 + 320 bytes), cp-amm `state/config.rs`.
pub mod damm_config {
    pub const LEN: usize = 328;
    pub const POOL_CREATOR_AUTHORITY: usize = 40;
}

/// SPL Token account fields.
pub const TOKEN_ACCOUNT_LEN: usize = 165;

// ---- little-endian readers and writers ----
#[inline]
pub fn rd_u16(d: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([d[at], d[at + 1]])
}
#[inline]
pub fn rd_u32(d: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([d[at], d[at + 1], d[at + 2], d[at + 3]])
}
#[inline]
pub fn rd_u64(d: &[u8], at: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&d[at..at + 8]);
    u64::from_le_bytes(b)
}
#[inline]
pub fn rd_u128(d: &[u8], at: usize) -> u128 {
    let mut b = [0u8; 16];
    b.copy_from_slice(&d[at..at + 16]);
    u128::from_le_bytes(b)
}
#[inline]
pub fn wr_u16(d: &mut [u8], at: usize, v: u16) {
    d[at..at + 2].copy_from_slice(&v.to_le_bytes());
}
#[inline]
pub fn wr_u32(d: &mut [u8], at: usize, v: u32) {
    d[at..at + 4].copy_from_slice(&v.to_le_bytes());
}
#[inline]
pub fn wr_u64(d: &mut [u8], at: usize, v: u64) {
    d[at..at + 8].copy_from_slice(&v.to_le_bytes());
}
#[inline]
pub fn wr_i64(d: &mut [u8], at: usize, v: i64) {
    d[at..at + 8].copy_from_slice(&v.to_le_bytes());
}
#[inline]
pub fn wr_u128(d: &mut [u8], at: usize, v: u128) {
    d[at..at + 16].copy_from_slice(&v.to_le_bytes());
}

pub fn u128_of(v: [u64; 2]) -> u128 {
    v[0] as u128 | (v[1] as u128) << 64
}
pub fn split_u128(v: u128) -> [u64; 2] {
    [v as u64, (v >> 64) as u64]
}

/// A diary entry (64 bytes at the published offsets).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Entry {
    pub hour: u32,
    pub unix_hour: u32,
    pub slot: u64,
    pub call: u8,
    pub outcome: u8,
    pub lean: u16,
    pub n: u32,
    pub hits: u32,
    pub rule_hits: u32,
    pub next_lean: u16,
    pub next_call: u8,
    pub phase: u8,
    pub chapter: u8,
    pub detail: u8,
    pub flags: u16,
    pub bought: u64,
    pub burned: u64,
    pub brain: [u8; 4],
    pub held: u32,
}

impl Entry {
    pub fn write(&self, d: &mut [u8]) {
        wr_u32(d, 0, self.hour);
        wr_u32(d, 4, self.unix_hour);
        wr_u64(d, 8, self.slot);
        d[16] = self.call;
        d[17] = self.outcome;
        wr_u16(d, 18, self.lean);
        wr_u32(d, 20, self.n);
        wr_u32(d, 24, self.hits);
        wr_u32(d, 28, self.rule_hits);
        wr_u16(d, 32, self.next_lean);
        d[34] = self.next_call;
        d[35] = self.phase;
        d[36] = self.chapter;
        d[37] = self.detail;
        wr_u16(d, 38, self.flags);
        wr_u64(d, 40, self.bought);
        wr_u64(d, 48, self.burned);
        d[56..60].copy_from_slice(&self.brain);
        wr_u32(d, 60, self.held);
    }
    pub fn read(d: &[u8]) -> Self {
        let mut brain = [0u8; 4];
        brain.copy_from_slice(&d[56..60]);
        Entry {
            hour: rd_u32(d, 0),
            unix_hour: rd_u32(d, 4),
            slot: rd_u64(d, 8),
            call: d[16],
            outcome: d[17],
            lean: rd_u16(d, 18),
            n: rd_u32(d, 20),
            hits: rd_u32(d, 24),
            rule_hits: rd_u32(d, 28),
            next_lean: rd_u16(d, 32),
            next_call: d[34],
            phase: d[35],
            chapter: d[36],
            detail: d[37],
            flags: rd_u16(d, 38),
            bought: rd_u64(d, 40),
            burned: rd_u64(d, 48),
            brain,
            held: rd_u32(d, 60),
        }
    }
}
