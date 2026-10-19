//! The rules as pure integer functions, mirrored one for one by `hunch/site/core/chain.js`.
//! No Solana types here, so the host tests can run them.

use crate::u256::U256;
use core::cmp::Ordering;

pub const ONE: i64 = 65_536;
pub const BAR: i64 = 600;
pub const WINDOW: i64 = 30;
pub const HOUR: i64 = 3_600;
pub const DAY: i64 = 86_400;
pub const H: i64 = 6;
pub const FEE_DENOM: u128 = 1_000_000_000;
/// The opening fee falls to 3.75% over 5 seconds; ticks start after it.
pub const OPENING_SECONDS: i64 = 5;
/// Hours from the first tick's hour before any hour is owed a score (the network needs 12 bars).
pub const WARM_HOURS: u32 = 3;
/// Missed bars filled at most.
pub const MAX_FILL: u32 = 12;
pub const LEAN_STRONG: u16 = 5_500;
/// 0.01 SOL: below it the budget waits; it is also the slice floor.
pub const MIN_HELD: u64 = 10_000_000;
pub const DAY_MAX_BUYS: u32 = 24;
pub const DAY_CAP_BPS: u64 = 2_000;
pub const DAY_CAP_FLOOR: u64 = 1_000_000_000;
pub const VOLUME_CAP_DIV: u64 = 4;
pub const GUARD_BPS: i64 = 500;
pub const GUARD_SAMPLES: usize = 6;
pub const GUARD_STALE: i64 = 1_200;
pub const BUY_GAP: i64 = 1_800;
#[cfg(not(feature = "test-wide-impact-cap"))]
pub const IMPACT_SQRT_BPS: u128 = 100;
/// Test-only build (deploy-wide/hunch.so): a cap wide enough for the post-swap check to fire.
#[cfg(feature = "test-wide-impact-cap")]
pub const IMPACT_SQRT_BPS: u128 = 300;
pub const POST_SWAP_NUM: u128 = 10_101;
pub const POST_SWAP_DEN: u128 = 10_000;
pub const MIN_OUT_BPS: u128 = 9_900;
pub const Q32: u128 = 1 << 32;

/// The compiled DBC config values `adopt_curve` requires.
pub mod compiled {
    /// Opening fee 50% ...
    pub const CLIFF_FEE_NUMERATOR: u64 = 500_000_000;
    /// ... falling linearly in 5 periods of 1 second ...
    pub const NUMBER_OF_PERIOD: u16 = 5;
    pub const PERIOD_FREQUENCY: u64 = 1;
    /// ... by 9.25 points each, to 3.75% (375 bps).
    pub const REDUCTION_FACTOR: u64 = 92_500_000;
    pub const BASE_FEE_MODE_LINEAR: u8 = 0;
    pub const ENDING_FEE_NUMERATOR: u64 = 37_500_000;
    pub const COLLECT_FEE_MODE_QUOTE: u8 = 0;
    pub const ACTIVATION_TIMESTAMP: u8 = 1;
    pub const MIGRATION_DAMM_V2: u8 = 1;
    pub const MIGRATION_FEE_CUSTOMIZABLE: u8 = 6;
    pub const MIGRATED_POOL_FEE_BPS: u16 = 375;
    pub const CREATOR_TRADING_FEE_PCT: u8 = 33;
    pub const PARTNER_LOCKED_PCT: u8 = 67;
    pub const CREATOR_LOCKED_PCT: u8 = 33;
    pub const TOKEN_UPDATE_IMMUTABLE: u8 = 1;
    pub const TOKEN_TYPE_SPL: u8 = 0;
    pub const TOKEN_DECIMALS: u8 = 6;
}

/// The pool phase (after graduation, on Meteora DAMM v2).
pub mod pool_phase {
    /// Hours from adoption's hour before any hour is owed a score: the adoption hour and the next.
    pub const WARM_HOURS: u32 = 2;
    /// adopt_pool: Hunch's position must hold, locked for good, at least this share of the liquidity DBC's
    /// migration builds from the pinned threshold and migration price (`migration_liquidity`; DBC gives the
    /// creator 33% of it). Nothing an outsider adds to the pool, or locks there, changes that figure.
    pub const MIN_POSITION_PCT: u128 = 25;
    /// DAMM v2's lowest sqrt price (cp-amm constants.rs MIN_SQRT_PRICE), the lower end of the full-range
    /// pool DBC's migration makes.
    pub const DAMM_MIN_SQRT_PRICE: u128 = 4_295_048_016;
    /// DAMM v2's fee denominators and caps (cp-amm constants.rs).
    pub const MAX_FEE_NUMERATOR_V0: u64 = 500_000_000;
    pub const MAX_FEE_NUMERATOR_V1: u64 = 990_000_000;
}
/// What Meteora did in a boundary interval (state.dist_cur / dist_prev).
pub mod dist {
    /// The fee configuration changed, or it is one Hunch cannot model (a dynamic fee, a fee schedule).
    pub const FEE: u8 = 1;
    /// The pool was paused at a tick (or at the tick before).
    pub const PAUSE: u8 = 2;
}

pub mod phase {
    pub const SETUP: u8 = 0;
    pub const CURVE: u8 = 1;
    pub const GRADUATING: u8 = 2;
    pub const POOL: u8 = 3;
    pub const BLIND: u8 = 4;
}
pub mod call {
    pub const NONE: u8 = 0;
    pub const QUIETER: u8 = 1;
    pub const BUSIER: u8 = 2;
}
pub mod outcome {
    pub const NONE: u8 = 0;
    pub const HIT: u8 = 1;
    pub const MISS: u8 = 2;
    pub const FORFEIT: u8 = 3;
    pub const NOT_SCORED: u8 = 4;
}
/// Diary flags (u16).
pub mod df {
    pub const FORFEIT: u16 = 1 << 0;
    pub const NO_OUTSIDE: u16 = 1 << 1;
    pub const GUARD: u16 = 1 << 2;
    pub const BELOW_MIN: u16 = 1 << 3;
    pub const VOLUME_CAP: u16 = 1 << 4;
    pub const FEE_CHANGED: u16 = 1 << 5;
    pub const PAUSED: u16 = 1 << 6;
    pub const GRADUATING: u16 = 1 << 7;
    pub const BLIND: u16 = 1 << 8;
    pub const WARMUP: u16 = 1 << 9;
    pub const DAY_RECORD: u16 = 1 << 10;
    pub const TIE: u16 = 1 << 11;
    pub const NO_ATTEMPT: u16 = 1 << 12;
    pub const STALE: u16 = 1 << 13;
    pub const DAY_CAP: u16 = 1 << 14;
    pub const CHAPTER: u16 = 1 << 15;
}
/// Open-call flags (u8).
pub mod sf {
    pub const FEE_CHANGED: u8 = 1;
    pub const PAUSED: u8 = 2;
    pub const GUARD: u8 = 4;
    pub const VOLUME_CAP: u8 = 8;
    pub const BLIND: u8 = 16;
    pub const WARMUP: u8 = 32;
    /// A tick in the hour before this boundary was missed: no call was made, the hour is forfeited.
    pub const GAP: u8 = 64;
}
/// Tape flags (u16).
pub mod tf {
    pub const BASELINE: u16 = 1;
    pub const BOUNDARY: u16 = 2;
    pub const GAP: u16 = 4;
    pub const BLIND: u16 = 8;
    pub const LEARNED: u16 = 16;
    pub const BUSIER: u16 = 32;
    pub const HAS_CALL: u16 = 64;
    pub const DAY_RECORD: u16 = 128;
}
/// Why a buy waited.
pub mod skip {
    pub const NONE: u8 = 0;
    pub const BELOW_MIN: u8 = 1;
    pub const GUARD: u8 = 2;
    pub const STALE: u8 = 3;
    pub const VOLUME_CAP: u8 = 4;
    pub const DAY_CAP: u8 = 5;
    pub const IMPACT_CAP: u8 = 6;
}

#[inline]
fn bit_len(v: u128) -> u32 {
    128 - v.leading_zeros()
}

/// sqrt(a) / sqrt(b) as a Q32.32 ratio of sqrt prices, floored; both scaled down together so a << 32
/// stays inside 128 bits.
pub fn ratio_q32(mut a: u128, mut b: u128) -> u128 {
    let m = if a > b { a } else { b };
    let bits = bit_len(m);
    if bits > 96 {
        a >>= bits - 96;
        b >>= bits - 96;
    }
    if b == 0 {
        return Q32;
    }
    (a << 32) / b
}

/// A sqrt-price ratio (Q32.32) to the price return in Q16.16: ratio^2 - 1, the ratio clamped to [0, 3].
pub fn ret_from_ratio(rq: u128) -> i64 {
    let c = if rq > 3 * Q32 { 3 * Q32 } else { rq };
    ((c * c) >> 48) as i64 - ONE
}

/// The outside part of a tick's sqrt-price ratio: Hunch's own buys taken out.
pub fn outside_ratio(ratio: u128, own_ratio: u64) -> u128 {
    if own_ratio as u128 == Q32 || own_ratio == 0 {
        return ratio;
    }
    let r = if ratio > 1 << 64 { 1 << 64 } else { ratio };
    (r << 32) / own_ratio as u128
}

/// Hunch's own price move accumulates multiplicatively (Q32.32).
pub fn compose_own_ratio(own_ratio: u64, before: u128, after: u128) -> u64 {
    let r = ratio_q32(after, before);
    let v = (own_ratio as u128 * r) >> 32;
    if v > u64::MAX as u128 {
        u64::MAX
    } else {
        v as u64
    }
}

/// The live base fee numerator of DBC's linear fee scheduler at `now`.
pub fn live_fee_numerator(cliff: u64, n_periods: u64, frequency: u64, reduction: u64, activation: u64, now: i64) -> u64 {
    if frequency == 0 {
        return cliff;
    }
    let elapsed = if (now as i128) > activation as i128 { (now as i128 - activation as i128) as u64 } else { 0 };
    let mut period = elapsed / frequency;
    if period > n_periods {
        period = n_periods;
    }
    cliff.saturating_sub(reduction.saturating_mul(period))
}

pub fn fee_bps(fee_num: u64) -> u16 {
    (fee_num / 100_000) as u16
}

/// Outside volume in lamports from an outside fee delta and the live fee numerator.
pub fn volume_of(outside_fee: u64, fee_num: u64) -> u64 {
    if fee_num == 0 {
        return 0;
    }
    let v = outside_fee as u128 * FEE_DENOM / fee_num as u128;
    if v > u64::MAX as u128 {
        u64::MAX
    } else {
        v as u64
    }
}

/// Volume per 600 seconds.
pub fn per_bar(vol: u64, elapsed: i64) -> u64 {
    if elapsed <= 0 {
        return vol;
    }
    let v = vol as u128 * BAR as u128 / elapsed as u128;
    if v > u64::MAX as u128 {
        u64::MAX
    } else {
        v as u64
    }
}

pub fn isqrt(v: u128) -> u128 {
    if v < 2 {
        return v;
    }
    let mut x: u128 = 1 << bit_len(v).div_ceil(2);
    loop {
        let y = (x + v / x) >> 1;
        if y >= x {
            return x;
        }
        x = y;
    }
}

/// 1.96 x sqrt(0.25 / n) in basis points: 9800 / sqrt(n).
pub fn luck_band_bps(n: u32) -> u16 {
    if n == 0 {
        return 0;
    }
    let r = isqrt((n as u128) << 32);
    ((9_800u128 << 16) / r) as u16
}

/// The lean toward busier in basis points, rounded half up.
pub fn lean_bps(p: i64) -> u16 {
    ((p * 10_000 + ONE / 2) / ONE) as u16
}

/// The buy multiplier in tenths: 15 for a quieter call leaning at least 55/45, 5 for busier, else 10.
pub fn multiplier(call_: u8, lean: u16) -> u8 {
    if call_ == call::QUIETER && 10_000 - lean >= LEAN_STRONG {
        15
    } else if call_ == call::BUSIER && lean >= LEAN_STRONG {
        5
    } else {
        10
    }
}

/// held / 6 x m, at least 0.01 SOL and at most what is held; 0 below the floor.
pub fn planned_slice(held: u64, mult: u8) -> u64 {
    if held < MIN_HELD {
        return 0;
    }
    let mut s = (held as u128 * mult as u128 / 60) as u64;
    if s < MIN_HELD {
        s = MIN_HELD;
    }
    if s > held {
        s = held;
    }
    s
}

/// The last 24 scored results as bits (newest in bit 0).
pub fn push_recent(bits: u32, len: u32, hit: bool) -> (u32, u32) {
    (((bits << 1) | hit as u32) & 0xFF_FFFF, if len < 24 { len + 1 } else { 24 })
}

/// Input 10: hits / scored over the last 24 scored hours, minus one half.
pub fn hit_rate_input(bits: u32, len: u32) -> i32 {
    if len == 0 {
        return 0;
    }
    let mask = if len >= 32 { u32::MAX } else { (1u32 << len) - 1 };
    let hits = (bits & mask).count_ones() as i64;
    ((hits * ONE) / len as i64 - ONE / 2) as i32
}

/// One curve point of a DBC config: the segment ends at `sqrt_price` with `liquidity` below it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Point {
    pub sqrt_price: u128,
    pub liquidity: u128,
}

/// The SOL that moves sqrt_price from `sp` up by 1%, with the smallest liquidity among the segments the
/// range touches: L_min x (target - sp) / 2^128, rounded down. The curve ends at the migration price
/// (`stop`, 0 for none): segments past it are never traded, so they are not counted; a slice that
/// would go past it completes the curve with a partial fill.
pub fn impact_cap(sp: u128, sqrt_start: u128, curve: &[Point], stop: u128) -> u64 {
    let target = sp + sp * IMPACT_SQRT_BPS / 10_000;
    let reach = if stop != 0 && stop < target { stop } else { target };
    let mut lower = sqrt_start;
    let mut min_l: Option<u128> = None;
    for p in curve {
        if p.sqrt_price == 0 || p.liquidity == 0 {
            break;
        }
        if p.sqrt_price > sp && lower < reach {
            min_l = Some(match min_l {
                Some(m) if m < p.liquidity => m,
                _ => p.liquidity,
            });
        }
        lower = p.sqrt_price;
    }
    match min_l {
        None => 0,
        Some(l) => {
            let v = U256::mul(l, target - sp).shr(128).to_u128().unwrap_or(u128::MAX);
            if v > u64::MAX as u128 {
                u64::MAX
            } else {
                v as u64
            }
        }
    }
}

/// DBC's ExactIn quote to base (QuoteToken fee mode, fee on input), stopping at the migration price.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Quote {
    pub out: u64,
    pub next_sqrt_price: u128,
    pub partial: bool,
    pub fee: u64,
}

pub fn quote_buy(sp: u128, curve: &[Point], stop: u128, fee_num: u64, amount_in: u64) -> Quote {
    let fee = ((amount_in as u128 * fee_num as u128 + FEE_DENOM - 1) / FEE_DENOM) as u64;
    let mut left = (amount_in - fee) as u128;
    let mut cur = sp;
    let mut out = U256::ZERO;
    let ceil = U256::from_u128(u128::MAX); // 2^128 - 1
    for p in curve {
        if p.sqrt_price == 0 || p.liquidity == 0 {
            break;
        }
        let rf = if stop < p.sqrt_price { stop } else { p.sqrt_price };
        if rf <= cur {
            continue;
        }
        let l = p.liquidity;
        let max_in = U256::mul(l, rf - cur).add(&ceil).shr(128);
        if U256::from_u128(left).cmp(&max_in) == Ordering::Less {
            let next = cur + U256::from_u128(left).shl(128).div(&U256::from_u128(l)).to_u128().unwrap_or(0);
            out = out.add(&U256::mul(l, next - cur).div(&U256::mul(cur, next)));
            cur = next;
            left = 0;
            break;
        }
        out = out.add(&U256::mul(l, rf - cur).div(&U256::mul(cur, rf)));
        cur = rf;
        left -= max_in.to_u128().unwrap_or(left);
        if rf == stop {
            break;
        }
    }
    let o = out.to_u128().unwrap_or(u64::MAX as u128);
    Quote { out: if o > u64::MAX as u128 { u64::MAX } else { o as u64 }, next_sqrt_price: cur, partial: left > 0, fee }
}

/// The median of up to 6 sqrt prices (the mean of the two middle ones for an even count).
pub fn median(vals: &mut [u128]) -> u128 {
    let n = vals.len();
    // insertion sort, n <= 6
    for i in 1..n {
        let mut j = i;
        while j > 0 && vals[j - 1] > vals[j] {
            vals.swap(j - 1, j);
            j -= 1;
        }
    }
    if n == 0 {
        0
    } else if n % 2 == 1 {
        vals[(n - 1) / 2]
    } else {
        (vals[n / 2 - 1] + vals[n / 2]) / 2
    }
}

/// The guard: the spot price against the median of the last samples, as a Q16.16 price ratio
/// (the sqrt ratio squared). `Some(excess in tenths of a percent)` when it is more than 5% over.
pub fn guard_excess(spot: u128, med: u128) -> Option<u8> {
    let rq = ratio_q32(spot, med);
    let c = if rq > 3 * Q32 { 3 * Q32 } else { rq };
    let sq = ((c * c) >> 48) as i64;
    if sq * 10_000 > ONE * (10_000 + GUARD_BPS) {
        let tenths = (sq - ONE) * 1_000 / ONE;
        Some(if tenths > 255 { 255 } else { tenths as u8 })
    } else {
        None
    }
}

/// The fee a DAMM v2 pool charges now, from its fee fields, and whether Hunch can model it exactly:
/// a static base fee (a time scheduler with no periods left to run, which is what DBC's migration makes
/// and all Meteora's update_pool_fees can change) and no dynamic fee. Anything else is "not plain": the
/// numerator is still the best reading (the cliff plus the live variable fee), but the hours are not scored.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DammFee {
    pub cliff: u64,
    pub mode: u8,
    pub n_periods: u16,
    pub frequency: u64,
    pub reduction: u64,
    pub dynamic: bool,
    pub volatility_accumulator: u128,
    pub bin_step: u16,
    pub variable_fee_control: u32,
    pub fee_version: u8,
}

/// DAMM v2's variable fee: ceil((volatility_accumulator x bin_step)^2 x variable_fee_control / 1e11),
/// saturating where DAMM v2 would fail.
pub fn damm_variable_fee(vol_acc: u128, bin_step: u16, control: u32) -> u128 {
    let vb = vol_acc.saturating_mul(bin_step as u128);
    let sq = vb.saturating_mul(vb);
    let v = sq.saturating_mul(control as u128);
    v.saturating_add(99_999_999_999) / 100_000_000_000
}

impl DammFee {
    pub fn plain(&self) -> bool {
        (self.mode == 0 || self.mode == 1) && (self.n_periods == 0 || self.frequency == 0 || self.reduction == 0) && !self.dynamic
    }
    pub fn numerator(&self) -> u64 {
        let max = if self.fee_version == 0 { pool_phase::MAX_FEE_NUMERATOR_V0 } else { pool_phase::MAX_FEE_NUMERATOR_V1 };
        let var = if self.dynamic { damm_variable_fee(self.volatility_accumulator, self.bin_step, self.variable_fee_control) } else { 0 };
        let total = (self.cliff as u128).saturating_add(var);
        if total > max as u128 {
            max
        } else {
            total as u64
        }
    }
}

/// buy_and_burn_pool refuses (FEE_RAISED) a fee Hunch cannot model (a dynamic fee, a fee schedule still
/// running) or one above the fee at adoption: every hourly slice would pay it to the LPs and Meteora. A lower
/// fee is not refused. Mirrors `poolFeeRefused` in chain.js.
#[inline(never)]
pub fn pool_fee_refused(fee: &DammFee, adopt_fee_num: u64) -> bool {
    !fee.plain() || fee.numerator() > adopt_fee_num
}

/// The full-range DAMM v2 liquidity that `quote` lamports make at `sqrt_price`: DAMM v2 has
/// amount_b = L x (sqrt_price - sqrt_min) / 2^128, so L = quote x 2^128 / (sqrt_price - sqrt_min), floored.
/// With the DBC config's migration threshold and migration sqrt price it is the liquidity DBC's migration
/// builds (DBC deposits up to the threshold at that price), fixed before the pool exists. `None` at or
/// below the minimum sqrt price, or above 128 bits. Mirrors `migrationLiquidity` in chain.js.
pub fn migration_liquidity(quote: u64, sqrt_price: u128) -> Option<u128> {
    if sqrt_price <= pool_phase::DAMM_MIN_SQRT_PRICE {
        return None;
    }
    U256::from_u128(quote as u128).shl(128).div(&U256::from_u128(sqrt_price - pool_phase::DAMM_MIN_SQRT_PRICE)).to_u128()
}

/// adopt_pool's bar for the position: some liquidity locked for good, and at least 25% of the migration's
/// liquidity (exact 256-bit products). Mirrors `positionShareOk` in chain.js.
#[inline(never)]
pub fn position_share_ok(locked: u128, quote: u64, sqrt_price: u128) -> bool {
    match migration_liquidity(quote, sqrt_price) {
        Some(l) => locked > 0 && U256::mul(locked, 100).cmp(&U256::mul(l, pool_phase::MIN_POSITION_PCT)) != Ordering::Less,
        None => false,
    }
}

/// The impact cap on DAMM v2 (one full-range position): L x (1% of sqrt_price) / 2^128, with L the
/// smaller of the liquidity at the last tick and the live liquidity.
pub fn pool_impact_cap(sp: u128, liquidity: u128, sqrt_max: u128) -> u64 {
    impact_cap(sp, 0, &[Point { sqrt_price: sqrt_max, liquidity }], 0)
}

/// DAMM v2's ExactIn quote, SOL (token B) in, HUNCH (token A) out, fee on the way in (OnlyB): the same
/// arithmetic as one DBC segment (DAMM v2 get_next_sqrt_price_from_amount_in_b_rounding_down and
/// get_delta_amount_a_unsigned, rounding down).
pub fn quote_pool_buy(sp: u128, liquidity: u128, sqrt_max: u128, fee_num: u64, amount_in: u64) -> Quote {
    quote_buy(sp, &[Point { sqrt_price: sqrt_max, liquidity }], sqrt_max, fee_num, amount_in)
}

/// The graduation memo, written by the first boundary tick after adopt_pool.
pub const GRADUATION_LINE: &[u8] = b"graduated: it now learns from its Meteora DAMM v2 pool, with a new record.";

/// The chapter-change memo.
pub fn chapter_line(chapter: u8) -> &'static [u8] {
    match chapter {
        1 => b"chapter 1: it now reads its own last mistake.",
        2 => b"chapter 2: its second layer wakes.",
        3 => b"chapter 3: it now learns more slowly.",
        _ => b"",
    }
}
