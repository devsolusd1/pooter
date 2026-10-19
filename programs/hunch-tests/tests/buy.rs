//! buy_and_burn_curve against Meteora DBC's real bytecode (real claims, real swaps, real burns):
//! one test per rule, plus Hunch's own-trade exclusion (K6) and the compute it costs (K4).

use {
    hunch::{
        ids::{err, event},
        layout::*,
        rules::{self, df, skip, Point},
    },
    hunch_tests::*,
    solana_keypair::Keypair,
    solana_signer::Signer,
};

const H0: i64 = 1_790_002_800; // a UTC hour start
const SOL: u64 = 1_000_000_000;
const BAR: i64 = 600;

fn code<T>(r: Result<T, litesvm::types::FailedTransactionMetadata>) -> Option<u32> {
    r.err().and_then(|e| custom_code(&e))
}

/// A launched pool, the baseline tick at H0, then `bars` more bars each with a round trip of `churn`
/// lamports by a trader before its tick (at second 1). The clock ends on the last tick.
fn running(variant: &str, bars: i64, churn: u64) -> (Env, Keypair) {
    let mut env = Env::new(H0 - 500);
    env.launch(variant, H0 - 400, H0 - 300);
    let t = env.trader(5_000 * SOL);
    env.tick_at(H0 + 1).unwrap();
    for b in 1..=bars {
        bar(&mut env, &t, b, churn);
    }
    (env, t)
}

/// Bar `b` after H0: a round trip mid-way through the previous bar, then the tick at second 1.
fn bar(env: &mut Env, t: &Keypair, b: i64, churn: u64) {
    if churn > 0 {
        env.set_clock(H0 + b * BAR - 300, 0);
        env.churn(t, churn);
    }
    env.tick_at(H0 + b * BAR + 1).unwrap_or_else(|e| panic!("tick bar {b}: {:?}\n{}", e.err, e.meta.logs.join("\n")));
}

fn buy_at(env: &mut Env, ts: i64) -> Result<TransactionMetadata, litesvm::types::FailedTransactionMetadata> {
    env.set_clock(ts, (ts - 1_700_000_000) as u64);
    env.buy()
}

/// The buy event of a transaction: (held, spent, units, donated, own fee, min_out, sqrt before, sqrt after).
fn buy_event(env: &Env, r: &TransactionMetadata) -> Option<(u64, u64, u64, u64, u64, u64, u128, u128)> {
    let ixs = vec![cu_limit(400_000), env.buy_ix()];
    let keys = env.message_keys(&ixs, &env.payer.pubkey());
    env.events(r, &keys).into_iter().find(|(k, _)| *k == event::BUY).map(|(_, d)| {
        (rd_u64(&d, 0), rd_u64(&d, 8), rd_u64(&d, 16), rd_u64(&d, 24), rd_u64(&d, 32), rd_u64(&d, 40), rd_u128(&d, 48), rd_u128(&d, 64))
    })
}

fn config_curve(env: &Env) -> (u128, Vec<Point>, u128, u64) {
    let c = env.data(&env.pool().config);
    let curve = (0..20)
        .map(|k| Point { sqrt_price: rd_u128(&c, config::CURVE + 32 * k), liquidity: rd_u128(&c, config::CURVE + 32 * k + 16) })
        .collect();
    (rd_u128(&c, config::SQRT_START_PRICE), curve, rd_u128(&c, config::MIGRATION_SQRT_PRICE), rd_u64(&c, config::MIGRATION_QUOTE_THRESHOLD))
}

#[test]
fn buy_rules_in_order() {
    // two hours of bars with 1 SOL round trips: boundaries at H0+1h and H0+2h (bar 12)
    let (mut env, t) = running("good", 11, SOL);
    env.donate(2 * SOL);

    // hour 1: the previous hour has no outside volume measured yet (first boundary): the 25% cap waits
    let r = buy_at(&mut env, H0 + 3600 + 3000).expect("a capped buy succeeds and records why it waited");
    let st = env.state();
    assert_eq!((st.hs_reason, st.skips, st.buys), (skip::VOLUME_CAP, 1, 0));
    println!("hour 1: waited (outside volume cap), {} CU", hunch_cu(&r.logs).unwrap());

    // hour 2's boundary writes hour 1's diary line with the reason
    bar(&mut env, &t, 12, SOL);
    let e = Entry::read(&env.last_diary());
    assert!(e.flags & df::VOLUME_CAP != 0, "diary flags {:b}", e.flags);
    let line = hunch::format::diary_line(&e, b"HUNCH");
    let text = String::from_utf8(line.as_bytes().to_vec()).unwrap();
    assert!(text.contains("no buy: outside volume cap"), "{text}");
    println!("diary: {text}");
    for b in 13..=17 {
        bar(&mut env, &t, b, SOL);
    }

    // hour 2, at 55 minutes: the buy
    let supply = env.mint_supply();
    let fee_before = env.pool_fee_total();
    let r = buy_at(&mut env, H0 + 7200 + 3300).unwrap_or_else(|e| panic!("buy: {:?}\n{}", e.err, e.meta.logs.join("\n")));
    let cu = hunch_cu(&r.logs).unwrap();
    let (held, spent, units, donated, own_fee, min_out, p1, p2) = buy_event(&env, &r).expect("buy event");
    let st = env.state();
    println!("buy: held {held}, spent {spent} lamports, bought and burned {units} units, min_out {min_out}, own fee {own_fee}, sqrt x{:.6}, {cu} CU", p2 as f64 / p1 as f64);
    assert!(spent > 0 && units >= min_out && donated == 0);
    // min_out is 99% of the program's own quote, and that quote is exactly what DBC paid out
    assert_eq!(min_out as u128, units as u128 * 9_900 / 10_000, "own quote vs DBC's output {units}");
    assert_eq!(env.mint_supply(), supply - units, "everything bought is burned");
    assert_eq!(env.token_amount(&env.budget_hunch()), 0);
    assert!(p2 * 10_000 <= p1 * 10_100, "sqrt price moved more than 1%");
    assert_eq!(own_fee, env.pool_fee_total() - fee_before, "own fee = the counters' growth over the swap");
    assert_eq!((st.own_fee, st.own_lamports, st.buys, st.spent), (own_fee, spent, 1, spent));
    assert!(cu <= 250_000, "K4: a buy uses {cu} CU");
    let size = wire_size(&[cu_limit(400_000), env.buy_ix()], &env.payer.pubkey());
    println!("buy transaction: {size} bytes (1 signer, CU-limit instruction + buy_and_burn_curve, 19 accounts)");
    assert!(size <= 1232);

    // the same hour again: refused
    assert_eq!(code(buy_at(&mut env, H0 + 7200 + 3310)), Some(err::ALREADY_BOUGHT_THIS_HOUR));
    // hour 3 before its boundary tick: refused
    assert_eq!(code(buy_at(&mut env, H0 + 10800 + 5)), Some(err::NO_BOUNDARY_THIS_HOUR));
    // K6: no outside trade before this tick, only Hunch's buy: no outside volume, no outside move
    let cum_before = env.state().cum;
    env.tick_at(H0 + 10800 + 10).unwrap();
    let tape = env.last_tape();
    let ret = rd_u32(&tape, 32) as i32;
    assert_eq!(rd_u64(&tape, 24), cum_before, "Hunch's own fee is not outside volume");
    assert!(ret.abs() <= 1, "Hunch's own price move is taken out (outside return {ret})");
    assert_eq!(rd_u64(&tape, 40), spent, "the tape records Hunch's own lamports");
    assert_eq!(env.state().own_fee, 0);
    // less than 30 minutes after the previous buy: refused
    assert_eq!(code(buy_at(&mut env, H0 + 10800 + 30)), Some(err::TOO_SOON));
    // by CPI, and beside another instruction: refused
    let ix = env.buy_ix();
    let probe = env.via_probe(&ix);
    env.set_clock(H0 + 10800 + 1900, 0);
    assert_eq!(code(env.send_payer(&[cu_limit(400_000), probe])), Some(err::CALLED_BY_CPI));
    let payer = env.payer.pubkey();
    let t2 = t.pubkey();
    assert_eq!(code(env.send_payer(&[cu_limit(400_000), ix.clone(), system_transfer(&payer, &t2, 1)])), Some(err::NOT_ALONE));
    let sandwich = env.swap_ix(&t.pubkey(), true, SOL, 0);
    let tk = t.insecure_clone();
    let payer_kp = env.payer.insecure_clone();
    assert_eq!(code(env.send(&[cu_limit(600_000), sandwich, ix.clone()], &[&payer_kp, &tk])), Some(err::NOT_ALONE));
    // a foreign account in the budget's place: refused
    let mut bad = ix.clone();
    bad.accounts[4].pubkey = ata_of(&t.pubkey(), &wsol_mint());
    assert_eq!(code(env.send_payer(&[cu_limit(400_000), bad])), Some(err::WRONG_ACCOUNT));
    // ticks for the next bars (no outside trades), then 31 minutes 40 seconds after the previous buy: it buys again
    for b in 19..=21 {
        bar(&mut env, &t, b, 0);
    }
    let r = buy_at(&mut env, H0 + 10800 + 1900).unwrap();
    assert!(buy_event(&env, &r).is_some());
    println!("second buy, {} CU", hunch_cu(&r.logs).unwrap());
}

#[test]
fn guard_trips_on_a_pump_and_on_a_stale_tape() {
    let (mut env, t) = running("good", 12, SOL);
    env.donate(2 * SOL);
    // a pump right before the buy: more than 5% over the median of the last 6 samples
    env.set_clock(H0 + 7200 + 300, 0);
    env.trade(&t, true, 40 * SOL).unwrap();
    let r = buy_at(&mut env, H0 + 7200 + 320).unwrap();
    let st = env.state();
    assert_eq!(st.hs_reason, skip::GUARD);
    assert!(st.hs_detail > 50, "excess {} tenths of a percent", st.hs_detail);
    assert!(env.signal_bytes()[sig::FLAGS] & rules::sf::GUARD != 0);
    assert_eq!(st.buys, 0);
    println!("pump {}.{}% over the median: no buy ({} CU)", st.hs_detail / 10, st.hs_detail % 10, hunch_cu(&r.logs).unwrap());
    // the pump unwinds; a later call in the same hour buys (a skip does not use up the hour)
    let units = env.token_amount(&ata_of(&t.pubkey(), &env.pool().mint));
    env.trade(&t, false, units).unwrap();
    let r = buy_at(&mut env, H0 + 7200 + 400).unwrap();
    assert!(buy_event(&env, &r).is_some(), "the guard clears once the price is back");
    // hour 3: the boundary tick lands, then no tick for 21 minutes: the tape is stale
    for b in 13..=18 {
        bar(&mut env, &t, b, SOL);
    }
    buy_at(&mut env, H0 + 10800 + 1270).unwrap();
    assert_eq!(env.state().hs_reason, skip::STALE);
    // the next boundary's diary line says why
    for b in 21..=24 {
        bar(&mut env, &t, b, SOL);
    }
    let e = Entry::read(&env.last_diary());
    let text = String::from_utf8(hunch::format::diary_line(&e, b"HUNCH").as_bytes().to_vec()).unwrap();
    assert!(text.contains("no buy: the tape is stale"), "{text}");
    println!("diary: {text}");
}

#[test]
fn guard_line_names_the_excess() {
    let (mut env, t) = running("good", 12, SOL);
    env.donate(2 * SOL);
    env.set_clock(H0 + 7200 + 300, 0);
    env.trade(&t, true, 40 * SOL).unwrap();
    buy_at(&mut env, H0 + 7200 + 320).unwrap();
    let detail = env.state().hs_detail;
    for b in 13..=18 {
        bar(&mut env, &t, b, 0);
    }
    let e = Entry::read(&env.last_diary());
    let text = String::from_utf8(hunch::format::diary_line(&e, b"HUNCH").as_bytes().to_vec()).unwrap();
    assert!(text.contains(&format!("no buy: price {}.{}% over its hour median", detail / 10, detail % 10)), "{text}");
    println!("diary: {text}");
}

#[test]
fn caps_price_impact_volume_and_day() {
    // heavy volume, a large budget: the 1% price-impact cap binds
    let (mut env, t) = running("good", 12, 5 * SOL);
    env.donate(100 * SOL);
    let sp = env.pool_sqrt_price();
    let (start, curve, _, _) = config_curve(&env);
    let want_cap = rules::impact_cap(sp, start, &curve, config_curve(&env).2);
    let r = buy_at(&mut env, H0 + 7200 + 60).unwrap();
    let (held, spent, _, _, _, _, p1, p2) = buy_event(&env, &r).unwrap();
    let move_ppm = ((p2 as f64 / p1 as f64).powi(2) - 1.0) * 1e6;
    println!("impact cap {want_cap} lamports, held {held}, spent {spent}, price move {:.4}%", move_ppm / 1e4);
    assert_eq!(spent, want_cap, "the slice is cut to the impact cap");
    assert!(held / 6 > want_cap);
    assert!(move_ppm <= 21_000.0, "K5: a buy moves the price by 2.1% or less");

    // a quiet previous hour: 25% of it is under the floor, the budget waits
    let (mut env, t2) = running("good", 12, SOL / 1000);
    env.donate(2 * SOL);
    buy_at(&mut env, H0 + 7200 + 60).unwrap();
    let st = env.state();
    assert_eq!(st.hs_reason, skip::VOLUME_CAP);
    println!("quiet hour: previous hour {} lamports of outside volume, 25% cap {}: waits", st.hour_vol_prev, st.hour_vol_prev / 4);
    // a moderate hour: the slice is cut to 25% of it
    for b in 13..=18 {
        bar(&mut env, &t2, b, SOL / 40);
    }
    let r = buy_at(&mut env, H0 + 10800 + 60).unwrap();
    let st = env.state();
    let (_, spent, ..) = buy_event(&env, &r).expect("buy");
    assert_eq!(spent, st.hour_vol_prev / 4, "cut to 25% of the previous hour's outside volume");
    println!("moderate hour: cap {} = spent {spent}", st.hour_vol_prev / 4);

    // the day's cap: 20% of the pool's SOL side (at least 1 SOL), and 24 buys
    let _ = t;
    let (mut env, _t3) = running("good", 12, SOL);
    env.donate(2 * SOL);
    let day = ((H0 + 7200) / 86_400) as u32;
    env.set_state(|s| {
        s.buy_day = day + 1;
        s.day_cap = 1_000_000_000;
        s.day_spent = 1_000_000_000 - 5_000_000;
    });
    buy_at(&mut env, H0 + 7200 + 60).unwrap();
    assert_eq!(env.state().hs_reason, skip::DAY_CAP);
    // (each attempt below as if in a fresh hour: a second wait in one hour is refused, see
    // a_second_wait_in_an_hour_is_refused_and_changes_nothing)
    env.set_state(|s| {
        s.day_spent = 0;
        s.day_buys = 24;
        s.hs_hour = 0;
    });
    buy_at(&mut env, H0 + 7200 + 120).unwrap();
    assert_eq!(env.state().hs_reason, skip::DAY_CAP);
    // a new UTC day resets the counters and measures the cap from the pool's SOL side
    let q = rd_u64(&env.data(&env.pool().pool), pool::QUOTE_RESERVE);
    env.set_state(|s| {
        s.buy_day = day; // yesterday
        s.hs_hour = 0;
    });
    buy_at(&mut env, H0 + 7200 + 180).unwrap();
    let st = env.state();
    assert_eq!(st.day_cap, std::cmp::max(q / 5, SOL));
    println!("day cap measured at the day's first buy: {} lamports (pool SOL side {q})", st.day_cap);
}

#[test]
fn slice_multiplier_and_floor() {
    let (mut env, t) = running("good", 12, SOL);
    env.donate(SOL / 10);
    // a quieter call leaning 55/45 or more: x1.5
    env.set_signal_byte(sig::MULT, 15);
    let r = buy_at(&mut env, H0 + 7200 + 60).unwrap();
    let (held, spent, ..) = buy_event(&env, &r).unwrap();
    assert_eq!(spent, held * 15 / 60);
    println!("x1.5: held {held}, spent {spent}");
    // a busier call leaning 55/45 or more: x0.5
    for b in 13..=18 {
        bar(&mut env, &t, b, SOL);
    }
    env.set_signal_byte(sig::MULT, 5);
    let r = buy_at(&mut env, H0 + 10800 + 60).unwrap();
    let (held, spent, ..) = buy_event(&env, &r).unwrap();
    assert_eq!(spent, std::cmp::max(held * 5 / 60, 10_000_000).min(held));
    println!("x0.5: held {held}, spent {spent}");
    // the floor: with 0.03 SOL held, x0.5 would be 0.0025 SOL, so it buys 0.01 SOL
    assert_eq!(rules::planned_slice(30_000_000, 5), 10_000_000);
    assert_eq!(rules::planned_slice(9_999_999, 10), 0);
    assert_eq!(rules::multiplier(rules::call::QUIETER, 4500), 15);
    assert_eq!(rules::multiplier(rules::call::QUIETER, 4501), 10);
    assert_eq!(rules::multiplier(rules::call::BUSIER, 5500), 5);
    assert_eq!(rules::multiplier(rules::call::BUSIER, 5499), 10);
    assert_eq!(rules::multiplier(rules::call::NONE, 9000), 10);

    // below 0.01 SOL held: it waits
    let (mut env, _) = running("good", 12, 0);
    buy_at(&mut env, H0 + 7200 + 60).unwrap();
    assert_eq!(env.state().hs_reason, skip::BELOW_MIN);
}

#[test]
fn donated_hunch_is_burned_too() {
    let (mut env, t) = running("good", 12, SOL);
    env.donate(SOL);
    // a trader sends HUNCH to the budget's HUNCH account
    env.set_clock(H0 + 7200 + 30, 0);
    env.trade(&t, true, SOL / 10).unwrap();
    let mine = ata_of(&t.pubkey(), &env.pool().mint);
    let gift = env.token_amount(&mine) / 2;
    let to = env.budget_hunch();
    let tk = t.insecure_clone();
    let ix = token_transfer_ix(&mine, &to, &t.pubkey(), gift);
    env.send(&[ix], &[&tk]).unwrap();
    let supply = env.mint_supply();
    let r = buy_at(&mut env, H0 + 7200 + 60).unwrap();
    let (_, _, units, donated, ..) = buy_event(&env, &r).unwrap();
    assert_eq!(donated, gift);
    assert_eq!(env.mint_supply(), supply - units);
    let st = env.state();
    assert_eq!((st.donated, st.burned, st.bought_units), (gift, units, units - gift));
    println!("donated {gift} units burned with {} bought", units - gift);
}

#[test]
fn a_buy_across_a_segment_boundary_moves_the_price_by_at_most_2_01_percent() {
    let (mut env, t) = running("segments", 12, SOL / 2);
    let (start, curve, _, _) = config_curve(&env);
    let sp = env.pool_sqrt_price();
    // the next segment boundary above the price, and a buy that stops 0.4% (in sqrt) below it
    let i = curve.iter().position(|p| p.sqrt_price > sp).unwrap();
    let boundary = curve[i].sqrt_price;
    let target = boundary - boundary / 1000;
    let l = curve[i].liquidity;
    let net = (hunch::u256::U256::mul(l, target - sp).shr(128).to_u128().unwrap()) as u64;
    let gross = (net as u128 * 1_000_000_000 / (1_000_000_000 - 37_500_000)) as u64 + 1;
    env.set_clock(H0 + 7200 + 20, 0);
    env.trade(&t, true, gross).unwrap();
    println!("positioned: sp {} (boundary {boundary}, was {sp})", env.pool_sqrt_price());
    // six bars at the new price (so the guard's median is there), with volume
    for b in 13..=18 {
        bar(&mut env, &t, b, SOL / 2);
    }
    env.donate(200 * SOL);
    let sp = env.pool_sqrt_price();
    let below = curve[i].liquidity;
    let above = curve[i + 1].liquidity;
    let cap = rules::impact_cap(sp, start, &curve, config_curve(&env).2);
    let r = buy_at(&mut env, H0 + 10800 + 60).unwrap();
    let (_, spent, _, _, _, _, p1, p2) = buy_event(&env, &r).unwrap();
    println!("sqrt before {p1}, after {p2}, boundary {boundary}");
    let crossed = p1 < boundary && p2 > boundary;
    let move_pct = ((p2 as f64 / p1 as f64).powi(2) - 1.0) * 100.0;
    println!(
        "segment boundary at {boundary}: liquidity below {below}, above {above}; cap {cap} (smallest liquidity), spent {spent}, crossed {crossed}, price move {move_pct:.4}%"
    );
    assert!(crossed, "the buy crosses the segment boundary");
    assert_eq!(spent, cap);
    assert!(move_pct <= 2.01, "K5: {move_pct}%");
}

#[test]
fn hours_with_only_hunch_trading_are_not_scored() {
    // trades for three hours (so calls exist), then only Hunch buys for two hours
    let (mut env, t) = running("good", 18, SOL);
    env.donate(5 * SOL);
    for b in 19..=24 {
        bar(&mut env, &t, b, SOL);
    }
    // hours 4 and 5: no outside trades, a Hunch buy in each
    for h in 4..=5i64 {
        let r = buy_at(&mut env, H0 + h * 3600 + 120);
        assert!(r.is_ok(), "{:?}", r.err().map(|e| e.meta.logs));
        for b in (h * 6 + 1)..=(h * 6 + 6) {
            bar(&mut env, &t, b, 0);
        }
    }
    let e = Entry::read(&env.last_diary());
    assert_eq!(e.outcome, rules::outcome::NOT_SCORED, "flags {:b}", e.flags);
    assert!(e.flags & df::NO_OUTSIDE != 0);
    let text = String::from_utf8(hunch::format::diary_line(&e, b"HUNCH").as_bytes().to_vec()).unwrap();
    println!("diary: {text}");
    assert!(text.contains("not scored, no outside trades"));
}

#[test]
fn the_curve_completes_graduating_stops_buys_and_scoring() {
    let (mut env, t) = running("small", 12, SOL / 10);
    let (_, _, migration_sqrt, threshold) = config_curve(&env);
    println!("small curve: completes at {} SOL of quote reserve", threshold as f64 / 1e9);
    // a trader buys until the curve completes
    env.set_clock(H0 + 7200 + 20, 0);
    let mut n = 0;
    while rd_u64(&env.data(&env.pool().pool), pool::QUOTE_RESERVE) < threshold && n < 50 {
        let _ = env.trade_partial(&t, SOL);
        n += 1;
    }
    assert!(env.pool_sqrt_price() >= migration_sqrt || rd_u64(&env.data(&env.pool().pool), pool::QUOTE_RESERVE) >= threshold);
    // the next boundary tick sees it and turns to graduating
    for b in 13..=18 {
        bar(&mut env, &t, b, 0);
    }
    assert_eq!(env.state().phase, rules::phase::GRADUATING);
    assert_eq!(code(buy_at(&mut env, H0 + 10800 + 60)), Some(err::WRONG_PHASE));
    for b in 19..=24 {
        bar(&mut env, &t, b, 0);
    }
    let e = Entry::read(&env.last_diary());
    let text = String::from_utf8(hunch::format::diary_line(&e, b"HUNCH").as_bytes().to_vec()).unwrap();
    println!("diary: {text}");
    assert!(text.contains("graduating, not scored"));
}

#[test]
fn hunch_completes_the_curve_with_a_partial_fill() {
    let (mut env, t) = running("small", 6, SOL / 10);
    let (_, curve, migration_sqrt, threshold) = config_curve(&env);
    // bring the quote reserve to within 0.05 SOL of completing the curve
    env.set_clock(H0 + 3600 + 700, 0);
    for _ in 0..20 {
        let reserve = rd_u64(&env.data(&env.pool().pool), pool::QUOTE_RESERVE);
        let remaining = threshold - reserve;
        if remaining < SOL / 20 {
            break;
        }
        let gross = ((remaining - SOL / 40) as u128 * 1_000_000_000 / (1_000_000_000 - 37_500_000)) as u64;
        env.trade(&t, true, gross).unwrap();
    }
    let _ = (&curve, migration_sqrt);
    // a quiet hour at that price, with some volume for the 25% cap
    for b in 7..=12 {
        bar(&mut env, &t, b, SOL / 500);
    }
    env.donate(50 * SOL);
    let before = rd_u64(&env.data(&env.pool().pool), pool::QUOTE_RESERVE);
    let r = buy_at(&mut env, H0 + 7200 + 60).unwrap_or_else(|e| panic!("{:?}\n{}", e.err, e.meta.logs.join("\n")));
    let (held, spent, units, ..) = buy_event(&env, &r).unwrap();
    let after = rd_u64(&env.data(&env.pool().pool), pool::QUOTE_RESERVE);
    println!("partial fill: held {held}, spent {spent}, bought {units}; quote reserve {before} -> {after} (threshold {threshold})");
    assert!(after >= threshold, "Hunch's buy completed the curve");
    assert!(r.logs.iter().any(|l| l.contains("Instruction: Swap2")));
}

/// What a refused call must leave as it was: the state, the open call, the budget's WSOL, and the creator
/// fee still waiting on the pool (the claim is undone with the rest).
fn snapshot(env: &Env) -> (Vec<u8>, Vec<u8>, u64, u64) {
    (env.data(&env.state), env.signal_bytes(), env.token_amount(&env.budget_wsol), rd_u64(&env.data(&env.pool().pool), pool::CREATOR_QUOTE_FEE))
}

#[test]
fn a_second_wait_in_an_hour_is_refused_and_changes_nothing() {
    let (mut env, t) = running("good", 12, SOL);
    env.donate(2 * SOL);
    // hour 2: a pump right before the first call: it waits on the guard and records why
    env.set_clock(H0 + 7200 + 300, 0);
    env.trade(&t, true, 40 * SOL).unwrap();
    buy_at(&mut env, H0 + 7200 + 320).unwrap();
    let st = env.state();
    assert_eq!((st.hs_reason, st.skips, st.buys), (skip::GUARD, 1, 0));
    // more trades, so creator fee waits on the pool; then a second cranker on the same timing, which would
    // wait again: refused, with no claim, no counter and no state write
    env.set_clock(H0 + 7200 + 325, 0);
    env.trade(&t, true, SOL / 10).unwrap();
    let before = snapshot(&env);
    assert!(before.3 > 0, "creator fee waits on the pool");
    assert_eq!(code(buy_at(&mut env, H0 + 7200 + 330)), Some(err::ALREADY_WAITED_THIS_HOUR));
    assert!(snapshot(&env) == before, "a refused second wait changed something");
    // a second wait for another reason (the day's 24 buys used) is refused the same way
    let day = ((H0 + 7200) / 86_400) as u32;
    env.set_state(|s| {
        s.buy_day = day + 1;
        s.day_buys = 24;
    });
    let before = snapshot(&env);
    assert_eq!(code(buy_at(&mut env, H0 + 7200 + 335)), Some(err::ALREADY_WAITED_THIS_HOUR));
    assert!(snapshot(&env) == before);
    env.set_state(|s| s.day_buys = 0);
    let st = env.state();
    assert_eq!((st.hs_reason, st.skips, st.buys), (skip::GUARD, 1, 0), "one wait recorded");
    println!("hour 2: waited on the guard once; two more calls that would wait were refused and changed nothing");
    // the pump unwinds: a later call in the same hour can buy, so it buys (nobody can cancel the hour's buy
    // by calling at a bad moment)
    let units = env.token_amount(&ata_of(&t.pubkey(), &env.pool().mint));
    env.trade(&t, false, units).unwrap();
    let r = buy_at(&mut env, H0 + 7200 + 400).unwrap_or_else(|e| panic!("{:?}\n{}", e.err, e.meta.logs.join("\n")));
    let (_, spent, units, ..) = buy_event(&env, &r).expect("a buy after a wait in the same hour");
    let st = env.state();
    assert_eq!((st.hs_reason, st.skips, st.buys, st.hs_bought), (skip::NONE, 1, 1, spent));
    // after the buy, any further call in the hour is refused as before, one that would wait included
    env.set_clock(H0 + 7200 + 405, 0);
    env.trade(&t, true, 40 * SOL).unwrap();
    assert_eq!(code(buy_at(&mut env, H0 + 7200 + 410)), Some(err::ALREADY_BOUGHT_THIS_HOUR));
    let units_t = env.token_amount(&ata_of(&t.pubkey(), &env.pool().mint));
    env.set_clock(H0 + 7200 + 415, 0);
    env.trade(&t, false, units_t).unwrap();
    assert_eq!(code(buy_at(&mut env, H0 + 7200 + 3_500)), Some(err::ALREADY_BOUGHT_THIS_HOUR));
    // the next boundary's diary line tells the buy, not the wait
    for b in 13..=18 {
        bar(&mut env, &t, b, SOL);
    }
    let e = Entry::read(&env.last_diary());
    assert_eq!((e.bought, e.burned), (spent, units));
    assert!(e.flags & (df::GUARD | df::NO_ATTEMPT) == 0, "flags {:b}", e.flags);
    let text = String::from_utf8(hunch::format::diary_line(&e, b"HUNCH").as_bytes().to_vec()).unwrap();
    println!("diary: {text}");
}

#[test]
fn the_diary_line_names_the_ticker_set_at_initialize() {
    let mut env = Env::new(H0 - 500);
    env.launch_ticker("good", H0 - 400, H0 - 300, b"HOURHOG");
    assert_eq!(&env.state().ticker, b"HOURHOG\0\0\0\0\0\0\0\0\0");
    let t = env.trader(5_000 * SOL);
    env.tick_at(H0 + 1).unwrap();
    for b in 1..=12 {
        bar(&mut env, &t, b, SOL);
    }
    env.donate(2 * SOL);
    let r = buy_at(&mut env, H0 + 7200 + 60).unwrap_or_else(|e| panic!("{:?}\n{}", e.err, e.meta.logs.join("\n")));
    let (_, spent, units, ..) = buy_event(&env, &r).expect("a buy");
    for b in 13..=17 {
        bar(&mut env, &t, b, SOL);
    }
    env.set_clock(H0 + 18 * BAR - 300, 0);
    env.churn(&t, SOL);
    let r = env.tick_at(H0 + 18 * BAR + 1).unwrap();
    let memo = memos(&r.logs)[0].clone();
    let e = Entry::read(&env.last_diary());
    assert_eq!((e.bought, e.burned), (spent, units));
    let want = String::from_utf8(hunch::format::diary_line(&e, b"HOURHOG").as_bytes().to_vec()).unwrap();
    println!("memo: {memo}");
    assert_eq!(memo, want, "the memo is the formatter's line with the stored ticker");
    assert!(memo.contains(" HOURHOG. next: ") && !memo.contains("HUNCH"), "{memo}");
}

/// SOL sent straight to the budget's WSOL account joins the budget (sync_native), but `claimed` counts only
/// the creator fee DBC's claim paid, in claim_curve_fees and in buy_and_burn_curve alike.
#[test]
fn sol_sent_to_the_wsol_account_is_not_recorded_as_claimed() {
    let (mut env, t) = running("good", 6, SOL);
    let creator_fee = |env: &Env| rd_u64(&env.data(&env.pool().pool), pool::CREATOR_QUOTE_FEE);
    // claim_curve_fees with 3 SOL sent to the WSOL account first
    env.set_clock(H0 + 6 * BAR + 30, 0);
    env.donate(3 * SOL);
    let (fee, w0, c0) = (creator_fee(&env), env.token_amount(&env.budget_wsol), env.state().claimed);
    env.send_payer(&[cu_limit(200_000), env.claim_ix()]).unwrap_or_else(|e| panic!("claim_curve_fees: {:?}\n{}", e.err, e.meta.logs.join("\n")));
    let (w1, c1) = (env.token_amount(&env.budget_wsol), env.state().claimed);
    println!("claim_curve_fees after 3 SOL sent: creator fee {fee}, WSOL +{}, claimed +{}", w1 - w0, c1 - c0);
    assert!(fee > 0 && creator_fee(&env) == 0, "the creator fee was claimed");
    assert_eq!(w1 - w0, 3 * SOL + fee, "the 3 SOL joined the budget");
    assert_eq!(c1 - c0, fee, "claimed counts only the creator fee");
    // buy_and_burn_curve (it buys or records why it waits; either way it claims) with 1 SOL sent first
    env.set_clock(H0 + 6 * BAR + 40, 0);
    env.churn(&t, SOL);
    env.donate(SOL);
    let (fee, c0) = (creator_fee(&env), env.state().claimed);
    buy_at(&mut env, H0 + 6 * BAR + 60).unwrap_or_else(|e| panic!("buy: {:?}\n{}", e.err, e.meta.logs.join("\n")));
    let c1 = env.state().claimed;
    println!("buy_and_burn_curve after 1 SOL sent: creator fee {fee}, claimed +{}", c1 - c0);
    assert!(fee > 0);
    assert_eq!(c1 - c0, fee, "claimed counts only the creator fee");
}
