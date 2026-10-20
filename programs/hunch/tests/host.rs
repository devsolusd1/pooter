//! The program's pure parts on the host: the buy rules and the curve math against chain.js case by case
//! (programs/tests/vectors/rules.txt), the diary formatter against every memo line of the chain replay,
//! and the 256-bit arithmetic.

use hunch::{
    format::diary_line,
    layout::{Entry, State, STATE_LEN},
    rules::{self, Point},
    u256::U256,
};
use std::fs;

fn vectors(name: &str) -> String {
    fs::read_to_string(format!("{}/../tests/vectors/{name}", env!("CARGO_MANIFEST_DIR"))).expect("run node hunch/scripts/export-vectors.mjs first")
}

fn curve_of(tok: &[&str], k: usize) -> Vec<Point> {
    (0..k).map(|j| Point { sqrt_price: tok[2 * j].parse().unwrap(), liquidity: tok[2 * j + 1].parse().unwrap() }).collect()
}

#[test]
fn buy_rules_equal_chain_js() {
    let text = vectors("rules.txt");
    let mut counts = std::collections::BTreeMap::<&str, usize>::new();
    for line in text.lines().filter(|l| !l.starts_with('#') && !l.is_empty()) {
        if let Some(rest) = line.strip_prefix("line\t") {
            // the diary formatter on a synthetic entry: line<TAB>entry hex<TAB>chain.js's text
            let (h, want) = rest.split_once('\t').unwrap();
            let bytes: Vec<u8> = (0..h.len()).step_by(2).map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap()).collect();
            let e = Entry::read(&bytes);
            let got = diary_line(&e, b"HUNCH");
            assert_eq!(std::str::from_utf8(got.as_bytes()).unwrap(), want, "entry {h}");
            *counts.entry("line").or_default() += 1;
            continue;
        }
        let t: Vec<&str> = line.split_whitespace().collect();
        let n = |i: usize| t[i].parse::<u128>().unwrap();
        match t[0] {
            "ratio" => {
                let rq = rules::ratio_q32(n(1), n(2));
                assert_eq!(rq, n(3), "{line}");
                assert_eq!(rules::ret_from_ratio(rq), t[4].parse::<i64>().unwrap(), "{line}");
            }
            "band" => assert_eq!(rules::luck_band_bps(n(1) as u32) as u128, n(2), "{line}"),
            "impact" => {
                let (sp, stop, start, k) = (n(1), n(2), n(3), n(4) as usize);
                let curve = curve_of(&t[5..], k);
                assert_eq!(rules::impact_cap(sp, start, &curve, stop) as u128, n(5 + 2 * k), "{line}");
            }
            "quote" => {
                let (sp, stop, fee, amount, k) = (n(1), n(2), n(3) as u64, n(4) as u64, n(5) as usize);
                let curve = curve_of(&t[6..], k);
                let q = rules::quote_buy(sp, &curve, stop, fee, amount);
                let at = 6 + 2 * k;
                assert_eq!((q.out as u128, q.next_sqrt_price, q.partial as u128), (n(at), n(at + 1), n(at + 2)), "{line}");
            }
            "guard" => {
                let g = rules::guard_excess(n(1), n(2)).map(|v| v as i64).unwrap_or(-1);
                assert_eq!(g, t[3].parse::<i64>().unwrap(), "{line}");
            }
            "slice" => assert_eq!(rules::planned_slice(n(1) as u64, n(2) as u8) as u128, n(3), "{line}"),
            "mult" => assert_eq!(rules::multiplier(n(1) as u8, n(2) as u16) as u128, n(3), "{line}"),
            "fee" => {
                let f = rules::live_fee_numerator(500_000_000, 5, 1, 92_500_000, n(2) as u64, t[1].parse().unwrap());
                assert_eq!(f as u128, n(3), "{line}");
            }
            "median" => {
                let k = n(1) as usize;
                let mut v: Vec<u128> = (0..k).map(|i| n(2 + i)).collect();
                assert_eq!(rules::median(&mut v), n(2 + k), "{line}");
            }
            // the pool phase: DAMM v2's impact cap and quote, and the fee fields read from a pool account
            "pimpact" => assert_eq!(rules::pool_impact_cap(n(1), n(2), n(3)) as u128, n(4), "{line}"),
            "pquote" => {
                let q = rules::quote_pool_buy(n(1), n(2), n(3), n(4) as u64, n(5) as u64);
                assert_eq!((q.out as u128, q.next_sqrt_price, q.partial as u128), (n(6), n(7), n(8)), "{line}");
            }
            "dfee" => {
                let fb: Vec<u8> = (0..t[1].len()).step_by(2).map(|i| u8::from_str_radix(&t[1][i..i + 2], 16).unwrap()).collect();
                let mut pool = vec![0u8; hunch::layout::damm::LEN];
                pool[8..80].copy_from_slice(&fb[..72]);
                pool[484..487].copy_from_slice(&fb[72..75]);
                pool[hunch::layout::damm::VOLATILITY_ACCUMULATOR..hunch::layout::damm::VOLATILITY_ACCUMULATOR + 16].copy_from_slice(&n(2).to_le_bytes());
                let f = hunch::layout::damm_fee_of(&pool);
                assert_eq!((f.numerator() as u128, f.plain() as u128), (n(3), n(4)), "{line}");
            }
            other => panic!("unknown case {other}"),
        }
        *counts.entry(t[0]).or_default() += 1;
    }
    println!("rules equal to chain.js: {counts:?}");
}

/// adopt_pool's bar (the migration's liquidity from the pinned threshold and sqrt price) and
/// buy_and_burn_pool's fee refusal, against chain.js case by case (programs/tests/vectors/pool-rules.txt,
/// written by programs/tests/export-pool-rules.mjs).
#[test]
fn adoption_bar_and_pool_fee_refusal_equal_chain_js() {
    let text = vectors("pool-rules.txt");
    let mut counts = std::collections::BTreeMap::<&str, usize>::new();
    for line in text.lines().filter(|l| !l.starts_with('#') && !l.is_empty()) {
        let t: Vec<&str> = line.split_whitespace().collect();
        let n = |i: usize| t[i].parse::<u128>().unwrap();
        match t[0] {
            "mliq" => {
                let want = if t[3] == "-" { None } else { Some(n(3)) };
                assert_eq!(rules::migration_liquidity(n(1) as u64, n(2)), want, "{line}");
            }
            "share" => assert_eq!(rules::position_share_ok(n(1), n(2) as u64, n(3)) as u128, n(4), "{line}"),
            "pfee" => {
                let fb: Vec<u8> = (0..t[1].len()).step_by(2).map(|i| u8::from_str_radix(&t[1][i..i + 2], 16).unwrap()).collect();
                let mut pool = vec![0u8; hunch::layout::damm::LEN];
                pool[8..80].copy_from_slice(&fb[..72]);
                pool[484..487].copy_from_slice(&fb[72..75]);
                pool[hunch::layout::damm::VOLATILITY_ACCUMULATOR..hunch::layout::damm::VOLATILITY_ACCUMULATOR + 16].copy_from_slice(&n(2).to_le_bytes());
                let f = hunch::layout::damm_fee_of(&pool);
                assert_eq!(rules::pool_fee_refused(&f, n(3) as u64) as u128, n(4), "{line}");
            }
            other => panic!("unknown case {other}"),
        }
        *counts.entry(t[0]).or_default() += 1;
    }
    println!("adoption bar and pool fee refusal equal to chain.js: {counts:?}");
    assert!(counts.values().all(|c| *c >= 20) && counts.len() == 3);
}

/// The migration's liquidity is DAMM v2's own formula backwards: the SOL it holds at the migration price is
/// the quote (within one lamport, rounding down); the 25% bar sits exactly at a quarter of it.
#[test]
fn the_adoption_bar_is_a_quarter_of_the_migration_liquidity() {
    use rules::{migration_liquidity, pool_phase::DAMM_MIN_SQRT_PRICE as MIN, position_share_ok};
    // about the launch's numbers (96.1 SOL at the sqrt price of a $40k coin with SOL at $180), and extremes
    for (quote, sp) in [(96_101_000_000u64, 275_000_000_000_000_000u128), (1, MIN + 1_000_000_000), (u64::MAX, 1u128 << 80), (5_000_000_000, 1u128 << 100)] {
        let l = migration_liquidity(quote, sp).unwrap();
        let back = U256::mul(l, sp - MIN).shr(128).to_u128().unwrap();
        assert!(back <= quote as u128 && quote as u128 - back <= 1, "quote {quote} at {sp}: L {l} holds {back}");
        let q = (l * 25).div_ceil(100);
        assert!(position_share_ok(q, quote, sp) && !position_share_ok(q - 1, quote, sp), "the bar at 25% of {l}");
        assert!(position_share_ok(l * 33 / 100, quote, sp), "the creator's 33% passes");
    }
    assert_eq!(migration_liquidity(1, MIN), None);
    assert_eq!(migration_liquidity(1, 0), None);
    assert_eq!(migration_liquidity(u64::MAX, MIN + 1), None, "over 128 bits");
    assert!(!position_share_ok(0, 0, 1u128 << 64), "no locked liquidity: refused even when the bar is 0");
    assert!(!position_share_ok(u128::MAX, 96_101_000_000, 0), "no pinned migration price: refused");
}

#[test]
fn diary_lines_equal_chain_js_for_every_boundary() {
    let text = vectors("chain-replay.txt");
    let mut n = 0;
    for line in text.lines().filter(|l| l.starts_with("tick")) {
        let f: Vec<&str> = line.split('\t').collect();
        if f[14] == "-" {
            continue;
        }
        let bytes: Vec<u8> = (0..f[14].len()).step_by(2).map(|i| u8::from_str_radix(&f[14][i..i + 2], 16).unwrap()).collect();
        let e = Entry::read(&bytes);
        let mut back = [0u8; 64];
        e.write(&mut back);
        assert_eq!(&back[..], &bytes[..], "entry round trip");
        let l = diary_line(&e, b"HUNCH");
        assert_eq!(std::str::from_utf8(l.as_bytes()).unwrap(), f[15]);
        assert!(l.len <= 240 && l.as_bytes().iter().all(|b| b.is_ascii() && *b != b'"' && *b != b'\\' && *b != b'\n'));
        n += 1;
    }
    println!("{n} diary lines equal to chain.js's formatter");
    assert!(n > 600);
}

#[test]
fn u256_matches_u128_where_it_fits_and_divides_exactly() {
    let mut s = 0x1234_5678u64;
    let mut r = || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        s
    };
    for _ in 0..20_000 {
        let a = (r() as u128) << (r() % 64) | r() as u128;
        let b = (r() as u128) << (r() % 64) | r() as u128;
        let c = ((r() as u128) << (r() % 64) | r() as u128).max(1);
        let p = U256::mul(a, b);
        // (a * b) / c * c <= a * b < ((a * b) / c + 1) * c
        let q = p.div(&U256::from_u128(c));
        if let Some(q128) = q.to_u128() {
            assert!(U256::mul(q128, c).cmp(&p) != core::cmp::Ordering::Greater);
            assert!(U256::mul(q128 + 1, c).cmp(&p) == core::cmp::Ordering::Greater);
        }
        if let Some(v) = a.checked_mul(b) {
            assert_eq!(p.to_u128(), Some(v));
            assert_eq!(q.to_u128(), Some(v / c));
        }
        assert_eq!(p.shl(7).shr(7).cmp(&p) == core::cmp::Ordering::Equal, p.bits() <= 249);
        assert_eq!(p.add(&U256::from_u128(c)).sub(&U256::from_u128(c)), p);
    }
}

#[test]
fn layout_sizes() {
    assert_eq!(STATE_LEN % 8, 0);
    println!("state {} bytes, model {} bytes", STATE_LEN, hunch::layout::MODEL_LEN);
    assert_eq!(hunch::layout::TAPE_LEN, 6_936);
    assert_eq!(hunch::layout::DIARY_LEN, 9_240);
    assert!(hunch::layout::BOOK_INITIAL_LEN <= 10_240 && hunch::layout::BOOK_STEP * hunch::layout::BOOK_RECORD <= 10_240);
    assert_eq!(core::mem::align_of::<State>(), 8);
}

#[test]
fn the_ticker_names_the_coin_in_the_diary_line() {
    use hunch::layout::{ticker_ok, ticker_of, TICKER_MAX};
    for t in ["HUNCH", "HOURHOG", "PEABRAIN", "RUMINO", "A", "X1", "0123456789"] {
        assert!(ticker_ok(t.as_bytes()), "{t}");
    }
    for t in ["", "HOURHOGHOGS", "hunch", "Hunch", "HUN-CH", "HUN CH", "$HUNCH", "HUNCH.", "HÜNCH"] {
        assert!(!ticker_ok(t.as_bytes()), "{t:?} accepted");
    }
    assert_eq!(TICKER_MAX, 10);
    let mut st = State::default();
    assert_eq!(ticker_of(&st), b"");
    st.ticker[..7].copy_from_slice(b"HOURHOG");
    assert_eq!(ticker_of(&st), b"HOURHOG");
    st.ticker[..10].copy_from_slice(b"0123456789");
    assert_eq!(ticker_of(&st), b"0123456789");
    // a bought hour names the ticker; every other line is the same for any ticker
    let e = Entry { hour: 7, call: rules::call::QUIETER, outcome: rules::outcome::HIT, lean: 4_200, n: 5, hits: 3, rule_hits: 2, bought: 83_000_000, burned: 1_204_000_000_000, held: 1_000, ..Entry::default() };
    let text = |e: &Entry, t: &[u8]| String::from_utf8(diary_line(e, t).as_bytes().to_vec()).unwrap();
    assert!(text(&e, b"HOURHOG").contains(" bought 0.083 SOL, burned 1.20M HOURHOG. next:"), "{}", text(&e, b"HOURHOG"));
    assert_eq!(text(&e, b"HOURHOG").replace("HOURHOG", "HUNCH"), text(&e, b"HUNCH"));
    let waited = Entry { bought: 0, ..e };
    assert_eq!(text(&waited, b"HOURHOG"), text(&waited, b"HUNCH"));
    // the longest bought line with a 10-character ticker still fits in 240 bytes, untruncated (the
    // longest line overall is the guard's, which names no ticker)
    let worst = Entry {
        hour: u32::MAX,
        call: rules::call::QUIETER,
        outcome: rules::outcome::MISS,
        lean: 10_000,
        n: u32::MAX,
        hits: u32::MAX,
        rule_hits: u32::MAX,
        next_call: rules::call::QUIETER,
        next_lean: 10_000,
        bought: u64::MAX,
        burned: u64::MAX,
        held: u32::MAX,
        ..Entry::default()
    };
    let l = text(&worst, b"0123456789");
    println!("longest bought line with a 10-character ticker: {} bytes: {l}", l.len());
    assert!(l.len() < 240 && l.contains(" burned 18446.74B 0123456789. next: ") && l.ends_with("brain 00000000"), "{l}");
}

/// Prints (and checks against hunch/design/layout-final.md) the State layout from the Rust struct itself:
/// offset_of! for every field, with no gaps and nothing past STATE_LEN, so the table is complete.
#[test]
fn state_layout_table_is_generated_from_the_struct() {
    use core::mem::{offset_of, size_of};
    let s = State::default();
    let mut rows: Vec<(&str, usize, usize, &str)> = vec![];
    macro_rules! fields {
        ($($f:ident : $t:ty),* $(,)?) => {
            $({
                let _: &$t = &s.$f; // the type written here is the field's type
                rows.push((stringify!($f), offset_of!(State, $f), size_of::<$t>(), stringify!($t)));
            })*
        };
    }
    fields!(
        tag: [u8; 8], version: u8, phase: u8, chapter: u8, brain_source: u8, budget_bump: u8, event_bump: u8,
        last_outcome: u8, blind: u8, mint: [u8; 32], pool: [u8; 32], config: [u8; 32], base_vault: [u8; 32],
        quote_vault: [u8; 32], budget: [u8; 32], budget_wsol: [u8; 32], budget_hunch: [u8; 32], model: [u8; 32],
        tape: [u8; 32], signal: [u8; 32], diary: [u8; 32], book: [u8; 32], event_authority: [u8; 32],
        brain_hash: [u8; 32], seed: u32, launch_hour: u32, launch_ts: i64, activation_point: u64, cliff_fee: u64,
        reduction: u64, period_frequency: u64, n_periods: u64, migration_quote_threshold: u64, ticks: u64,
        last_tick_ts: i64, last_tick_bar: u32, start_hour: u32, last_sp: [u64; 2], last_fee_total: u64, cum: u64,
        own_fee: u64, own_ratio: u64, own_lamports: u64, last_attempt_bar: u32, blind_until_hour: u32,
        last_boundary_hour: u32, recent_len: u32, last_boundary_ts: i64, last_boundary_cum: u64, ref_vol: u64,
        ref_secs: u64, hour_vol_prev: u64, recent_bits: u32, last_record_day: u32, n: u32, hits: u32, rule_hits: u32,
        busier_hours: u32, quieter_calls: u32, quieter_hits: u32, forfeits: u32, not_scored: u32, last_buy_hour: u32,
        buy_day: u32, last_buy_ts: i64, day_buys: u32, hs_reason: u8, hs_detail: u8, pad0: [u8; 2], day_spent: u64,
        day_cap: u64, hs_hour: u32, pad1: u32, hs_bought: u64, hs_burned: u64, hs_held: u64, spent: u64,
        bought_units: u64, burned: u64, donated: u64, buys: u32, skips: u32, claimed: u64, last_missed_bar: u32,
        pad2: u32, damm_pool: [u8; 32], damm_config: [u8; 32], token_a_vault: [u8; 32], token_b_vault: [u8; 32],
        position: [u8; 32], position_nft: [u8; 32], position_mint: [u8; 32], last_liquidity: [u64; 2],
        adopt_fee_fp: u64, last_fee_fp: u64, adopt_fee_num: u64, surplus: u64, pool_claimed: u64, adopt_ts: i64,
        adopt_hour: u32, pool_warm_end: u32, prev_n: u32, prev_hits: u32, prev_rule_hits: u32, prev_forfeits: u32,
        prev_not_scored: u32, last_status: u8, dist_cur: u8, dist_prev: u8, grad_line: u8, ticker: [u8; 16],
        migration_sqrt_price: [u64; 2], withdrawn: u64, withdrawals: u32, last_withdraw_hour: u32,
        reserved: [u64; 2],
    );
    // complete: each field starts where the previous one ends, and the last ends at STATE_LEN
    let mut at = 0;
    for (name, off, size, _) in &rows {
        assert_eq!(*off, at, "a gap or a field missing from the list before {name}");
        at = off + size;
    }
    assert_eq!(at, STATE_LEN, "fields missing from the list at the end");
    // the stage-2 layout was 920 bytes: fields to 864, then a reserve
    const STAGE2_FIELDS_END: usize = 864;
    let mut table = String::from("| offset | size | field | type | since |\n|---:|---:|---|---|---|\n");
    for (name, off, size, ty) in &rows {
        let since = if *off < STAGE2_FIELDS_END {
            "stage 2"
        } else {
            match *name {
                "ticker" => "ticker (final)",
                "migration_sqrt_price" => "review fix (2026-10-16)",
                "withdrawn" | "withdrawals" | "last_withdraw_hour" => "withdraw_budget (2026-10-20)",
                "reserved" => "reserve",
                _ => "graduation",
            }
        };
        table.push_str(&format!("| {off} | {size} | `{name}` | `{}` | {since} |\n", ty.replace(' ', "")));
    }
    table.push_str(&format!("| {STATE_LEN} | | (end: STATE_LEN = {STATE_LEN}) | | |\n"));
    println!("State, {STATE_LEN} bytes:\n{table}");
    let doc = format!("{}/../../design/layout-final.md", env!("CARGO_MANIFEST_DIR"));
    if let Ok(text) = fs::read_to_string(&doc) {
        assert!(text.contains(&table), "hunch/design/layout-final.md does not hold this table; paste the printed one there");
    }
}

/// hunch/design/layout-final.md names every instruction tag and every error code as ids.rs has them.
#[test]
fn layout_doc_lists_every_instruction_tag_and_error_code() {
    use hunch::ids::{err, tag};
    let tags = [
        ("initialize", tag::INITIALIZE),
        ("load_brain", tag::LOAD_BRAIN),
        ("adopt_curve", tag::ADOPT_CURVE),
        ("tick", tag::TICK),
        ("buy_and_burn_curve", tag::BUY_AND_BURN_CURVE),
        ("claim_curve_fees", tag::CLAIM_CURVE_FEES),
        ("read_call", tag::READ_CALL),
        ("grow_brain_book", tag::GROW_BRAIN_BOOK),
        ("withdraw_surplus", tag::WITHDRAW_SURPLUS),
        ("adopt_pool", tag::ADOPT_POOL),
        ("buy_and_burn_pool", tag::BUY_AND_BURN_POOL),
        ("claim_pool_fees", tag::CLAIM_POOL_FEES),
        ("withdraw_budget", tag::WITHDRAW_BUDGET),
        ("event", tag::EVENT),
    ];
    let errors = [
        ("CALLED_BY_CPI", err::CALLED_BY_CPI),
        ("NOT_ALONE", err::NOT_ALONE),
        ("NOT_TOP_LEVEL", err::NOT_TOP_LEVEL),
        ("WRONG_ACCOUNT", err::WRONG_ACCOUNT),
        ("NOT_AUTHORITY", err::NOT_AUTHORITY),
        ("ALREADY_INITIALIZED", err::ALREADY_INITIALIZED),
        ("WRONG_PHASE", err::WRONG_PHASE),
        ("POOL_MISMATCH", err::POOL_MISMATCH),
        ("CONFIG_MISMATCH", err::CONFIG_MISMATCH),
        ("OUTSIDE_WINDOW", err::OUTSIDE_WINDOW),
        ("ALREADY_TICKED", err::ALREADY_TICKED),
        ("TOO_EARLY", err::TOO_EARLY),
        ("NO_BOUNDARY_THIS_HOUR", err::NO_BOUNDARY_THIS_HOUR),
        ("ALREADY_BOUGHT_THIS_HOUR", err::ALREADY_BOUGHT_THIS_HOUR),
        ("TOO_SOON", err::TOO_SOON),
        ("CURVE_COMPLETE", err::CURVE_COMPLETE),
        ("PRICE_MOVED_TOO_MUCH", err::PRICE_MOVED_TOO_MUCH),
        ("BAD_BRAIN", err::BAD_BRAIN),
        ("BOOK_HAS_ROOM", err::BOOK_HAS_ROOM),
        ("BLIND", err::BLIND),
        ("MATH", err::MATH),
        ("NOT_EVENT_AUTHORITY", err::NOT_EVENT_AUTHORITY),
        ("NOT_MIGRATED", err::NOT_MIGRATED),
        ("OUTSIDE_POOL", err::OUTSIDE_POOL),
        ("NOT_OUR_POSITION", err::NOT_OUR_POSITION),
        ("POOL_PAUSED", err::POOL_PAUSED),
        ("ALREADY_WAITED_THIS_HOUR", err::ALREADY_WAITED_THIS_HOUR),
        ("BAD_TICKER", err::BAD_TICKER),
        ("FEE_RAISED", err::FEE_RAISED),
        ("NOTHING_TO_WITHDRAW", err::NOTHING_TO_WITHDRAW),
        ("AMOUNT_TOO_HIGH", err::AMOUNT_TOO_HIGH),
    ];
    let doc = format!("{}/../../design/layout-final.md", env!("CARGO_MANIFEST_DIR"));
    let Ok(text) = fs::read_to_string(&doc) else {
        println!("no layout-final.md yet");
        return;
    };
    for (name, t) in tags {
        let row = if t == tag::EVENT { format!("| 0xE4 | `{name}` |") } else { format!("| {t} | `{name}` |") };
        assert!(text.contains(&row), "layout-final.md lacks the row {row}");
    }
    for (name, code) in errors {
        let row = format!("| {code} | `{name}` |");
        assert!(text.contains(&row), "layout-final.md lacks the row {row}");
    }
    println!("layout-final.md lists {} instruction tags and {} error codes as ids.rs has them", tags.len(), errors.len());
}

/// withdraw_budget's memo line: the amount truncated to 3 decimals, the stored ticker.
#[test]
fn the_withdrawal_memo_line() {
    use hunch::format::withdraw_line;
    let text = |l: u64, t: &[u8]| String::from_utf8(withdraw_line(l, t).as_bytes().to_vec()).unwrap();
    assert_eq!(
        text(5_381_999_999, b"POOTER"),
        "the developer withdrew 5.381 SOL from my budget to their wallet. They say they use it to buy POOTER and burn it by hand."
    );
    assert_eq!(text(1, b"HUNCH"), "the developer withdrew 0.000 SOL from my budget to their wallet. They say they use it to buy HUNCH and burn it by hand.");
    let worst = text(u64::MAX, b"0123456789");
    println!("longest withdrawal line: {} bytes: {worst}", worst.len());
    assert!(worst.len() < 240 && worst.ends_with(" by hand."), "{worst}");
}
