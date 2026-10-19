//! The adversarial suite (kill tests K4 and K5, and the attacks from the design's reviews), against
//! Meteora DBC's and SPL Memo's mainnet bytecode in LiteSVM. Every key is a throwaway made in memory.
//!
//! - ticks: the 30-second window, once per bar (blind ticks before the baseline too), by CPI, beside any
//!   other instruction (transfer, memo, swap, another Hunch instruction), a fake instructions sysvar;
//! - events: no program but Hunch can put a Hunch event in a transaction;
//! - buys: every one of the 19 accounts swapped for a foreign one, the timing rules, a 4.8% and a 5.2%
//!   pump against the 5% guard, min_out enforced by DBC, the post-swap revert (test-only wide-cap build),
//!   the price move per buy across segment boundaries;
//! - initialize and adopt_curve when someone pre-funds the PDAs or pre-creates the token accounts;
//! - a CPI scan of every path, and the worst-case compute (the longest memo line with a chapter change and
//!   a day record; an ordinary tick after a 13-bar gap that writes the day record) and transaction sizes.

use {
    hunch::{
        ids::{err, event, tag, CLAIM_CREATOR_TRADING_FEE2, SWAP2},
        layout::*,
        rules::{self, skip, Point},
        u256::U256,
    },
    hunch_net::SEED,
    hunch_tests::*,
    litesvm::types::FailedTransactionMetadata,
    solana_address::Address,
    solana_instruction::{account_meta::AccountMeta, Instruction},
    solana_instruction_error::InstructionError,
    solana_keypair::Keypair,
    solana_signer::Signer,
    solana_transaction_error::TransactionError,
    std::collections::BTreeSet,
};

const H0: i64 = 1_790_002_800; // a UTC hour start (15:00 UTC)
const SOL: u64 = 1_000_000_000;
const BAR: i64 = 600;

fn code<T>(r: Result<T, FailedTransactionMetadata>) -> Option<u32> {
    r.err().and_then(|e| custom_code(&e))
}
fn ix_error<T>(r: Result<T, FailedTransactionMetadata>) -> Option<InstructionError> {
    match r {
        Err(e) => match e.err {
            TransactionError::InstructionError(_, ie) => Some(ie),
            _ => None,
        },
        Ok(_) => None,
    }
}

fn launched(variant: &str) -> Env {
    let mut env = Env::new(H0 - 500);
    env.launch(variant, H0 - 400, H0 - 300);
    env
}

/// Bar `b`: a round trip of `churn` lamports half-way through the previous bar, then the tick at second 1.
fn bar(env: &mut Env, t: &Keypair, b: i64, churn: u64) {
    if churn > 0 {
        env.set_clock(H0 + b * BAR - 300, 0);
        env.churn(t, churn);
    }
    env.tick_at(H0 + b * BAR + 1).unwrap_or_else(|e| panic!("tick bar {b}: {:?}\n{}", e.err, e.meta.logs.join("\n")));
}

fn running(variant: &str, bars: i64, churn: u64) -> (Env, Keypair) {
    let mut env = launched(variant);
    let t = env.trader(20_000 * SOL);
    env.tick_at(H0 + 1).unwrap();
    for b in 1..=bars {
        bar(&mut env, &t, b, churn);
    }
    (env, t)
}

fn buy_at(env: &mut Env, ts: i64) -> Result<TransactionMetadata, FailedTransactionMetadata> {
    env.set_clock(ts, (ts - 1_700_000_000) as u64);
    env.buy()
}

/// The buy event: (held, spent, units, donated, own fee, min_out, sqrt before, sqrt after).
fn buy_event(env: &Env, r: &TransactionMetadata) -> Option<(u64, u64, u64, u64, u64, u64, u128, u128)> {
    let ixs = vec![cu_limit(400_000), env.buy_ix()];
    let keys = env.message_keys(&ixs, &env.payer.pubkey());
    env.events(r, &keys).into_iter().find(|(k, _)| *k == event::BUY).map(|(_, d)| {
        (rd_u64(&d, 0), rd_u64(&d, 8), rd_u64(&d, 16), rd_u64(&d, 24), rd_u64(&d, 32), rd_u64(&d, 40), rd_u128(&d, 48), rd_u128(&d, 64))
    })
}

fn config_curve(env: &Env) -> (u128, Vec<Point>, u128) {
    let c = env.data(&env.pool().config);
    let curve = (0..20)
        .map(|k| Point { sqrt_price: rd_u128(&c, config::CURVE + 32 * k), liquidity: rd_u128(&c, config::CURVE + 32 * k + 16) })
        .collect();
    (rd_u128(&c, config::SQRT_START_PRICE), curve, rd_u128(&c, config::MIGRATION_SQRT_PRICE))
}

/// The gross lamports a buy must spend to take sqrt_price from `sp` to `target` inside one segment of
/// liquidity `l`, at the 3.75% fee.
fn lamports_to(sp: u128, target: u128, l: u128) -> u64 {
    let net = U256::mul(l, target - sp).shr(128).to_u128().unwrap() as u64 + 1;
    (net as u128 * 1_000_000_000 / (1_000_000_000 - 37_500_000)) as u64 + 2
}
fn liquidity_at(curve: &[Point], sp: u128) -> u128 {
    curve.iter().find(|p| p.sqrt_price > sp).unwrap().liquidity
}

/// The median of the tape's last 6 sqrt prices, as the guard computes it.
fn tape_median(env: &Env) -> u128 {
    let d = env.data(&env.tape);
    let head = rd_u32(&d, 8) as usize;
    let mut v: Vec<u128> = (0..6)
        .map(|i| {
            let idx = (head + TAPE_ENTRIES - 1 - i) % TAPE_ENTRIES;
            rd_u128(&d[TAPE_HEADER + idx * TAPE_ENTRY..], 8)
        })
        .collect();
    rules::median(&mut v)
}

// ------------------------------------------------------------------------------------------------
// ticks
// ------------------------------------------------------------------------------------------------

#[test]
fn k5_tick_window_once_per_bar_top_level_and_alone() {
    let mut env = launched("good");
    let t = env.trader(1_000 * SOL);
    env.tick_at(H0 + 1).unwrap();
    for b in 1..=13 {
        bar(&mut env, &t, b, SOL);
    }
    let state_before = env.data(&env.state);
    // bar 14: every second from 30 to 599 is outside the window (a sample of them)
    let b14 = H0 + 14 * BAR;
    for sec in [30, 31, 45, 89, 90, 300, 599] {
        assert_eq!(code(env.tick_at(b14 + sec)), Some(err::OUTSIDE_WINDOW), "second {sec}");
    }
    assert_eq!(env.data(&env.state), state_before, "refused ticks change nothing");
    env.tick_at(b14 + 15).unwrap();
    // a second tick in the same bar, earlier or later in the window: refused
    for sec in [0, 14, 15, 16, 29] {
        assert_eq!(code(env.tick_at(b14 + sec)), Some(err::ALREADY_TICKED), "second {sec}");
    }
    // bar 15: by CPI, and beside any other instruction
    env.set_clock(b14 + BAR + 3, 0);
    let ix = env.tick_ix();
    let payer = env.payer.pubkey();
    let other = Keypair::new().pubkey();
    assert_eq!(code(env.send_payer(&[cu_limit(400_000), env.via_probe(&ix)])), Some(err::CALLED_BY_CPI));
    let read_call = env.read_call_ix();
    let buy = env.buy_ix();
    let alone_cases: Vec<(&str, Vec<Instruction>)> = vec![
        ("then a transfer", vec![ix.clone(), system_transfer(&payer, &other, 1)]),
        ("after a transfer", vec![system_transfer(&payer, &other, 1), ix.clone()]),
        ("then a memo", vec![cu_limit(400_000), ix.clone(), memo_ix("hour 9: leaned busier 99/1, came busier, hit. https://scam.invalid")]),
        ("after a memo", vec![memo_ix("fake"), cu_limit(400_000), ix.clone()]),
        ("with read_call", vec![cu_limit(400_000), ix.clone(), read_call.clone()]),
        ("with a buy", vec![cu_limit(600_000), ix.clone(), buy.clone()]),
        ("twice", vec![cu_limit(600_000), ix.clone(), ix.clone()]),
    ];
    for (what, ixs) in alone_cases {
        assert_eq!(code(env.send_payer(&ixs)), Some(err::NOT_ALONE), "tick {what}");
    }
    // a trader's swap in the same transaction (front or back): refused
    let tk = t.insecure_clone();
    let payer_kp = env.payer.insecure_clone();
    let swap = env.swap_ix(&t.pubkey(), true, SOL / 10, 0);
    assert_eq!(code(env.send(&[cu_limit(800_000), swap.clone(), ix.clone()], &[&payer_kp, &tk])), Some(err::NOT_ALONE));
    assert_eq!(code(env.send(&[cu_limit(800_000), ix.clone(), swap], &[&payer_kp, &tk])), Some(err::NOT_ALONE));
    // a fake instructions sysvar (to hide the other instructions): refused by the sysvar's address check
    let mut bad = ix.clone();
    bad.accounts[8].pubkey = Keypair::new().pubkey();
    assert_eq!(ix_error(env.send_payer(&[cu_limit(400_000), bad])), Some(InstructionError::UnsupportedSysvar));
    // an account that is not the one the state names, in every slot that holds one
    let wrong: Vec<(usize, Address)> = vec![
        (0, env.signal),
        (0, Keypair::new().pubkey()),
        (1, env.tape),
        (2, env.model),
        (3, env.diary),
        (4, env.signal),
        (5, env.tape),
        (6, Keypair::new().pubkey()),
        (7, ata_of(&payer, &wsol_mint())),
        (9, Keypair::new().pubkey()),
        (10, Keypair::new().pubkey()),
        (11, probe_id()),
    ];
    for (slot, addr) in wrong {
        let mut bad = ix.clone();
        bad.accounts[slot].pubkey = addr;
        let r = env.send_payer(&[cu_limit(400_000), bad]);
        assert!(r.is_err(), "account {slot} swapped: accepted");
        assert_eq!(code(r), Some(err::WRONG_ACCOUNT), "account {slot}");
    }
    // ComputeBudget instructions beside it are fine
    env.send_payer(&[cu_limit(400_000), cu_price(1_000), ix]).unwrap();
    println!("tick: refused outside the window, twice in a bar, by CPI, beside 9 kinds of instruction, with a fake sysvar and 10 foreign accounts");
}

#[test]
fn blind_ticks_are_once_per_bar_before_the_baseline_too() {
    // the pool's layout changes before the first tick lands: blind ticks do not count as the baseline,
    // and before the fix a blind tick could be repeated in the same bar (one diary entry each)
    let mut env = launched("good");
    let pool = env.pool().pool;
    let mut changed = env.svm.get_account(&pool).unwrap();
    changed.data[0] ^= 0xff;
    env.svm.set_account(pool, changed).unwrap();
    env.tick_at(H0 + 1).unwrap();
    assert_eq!(env.diary_total(), 1, "the blind boundary writes its line");
    assert_eq!(code(env.tick_at(H0 + 2)), Some(err::ALREADY_TICKED));
    assert_eq!(code(env.tick_at(H0 + 29)), Some(err::ALREADY_TICKED));
    assert_eq!(env.diary_total(), 1);
    env.tick_at(H0 + BAR + 1).unwrap();
    assert_eq!(env.state().ticks, 0, "blind ticks are not the baseline");
}

#[test]
fn fake_events_from_other_programs_are_refused() {
    let mut env = launched("good");
    env.tick_at(H0 + 1).unwrap();
    let payer = env.payer.pubkey();
    let mut data = vec![tag::EVENT, event::DIARY];
    data.extend_from_slice(&[0u8; 64]);
    let fake = Instruction {
        program_id: env.hunch,
        accounts: vec![AccountMeta::new_readonly(payer, true), AccountMeta::new_readonly(ix_sysvar(), false)],
        data,
    };
    // top level: refused (an event is only a self-CPI)
    assert_eq!(code(env.send_payer(&[fake.clone()])), Some(err::NOT_EVENT_AUTHORITY));
    // by CPI from another program with a signer: refused (before the fix this put a fake Hunch DiaryEntry
    // event in the transaction's inner instructions)
    assert_eq!(code(env.send_payer(&[env.via_probe(&fake)])), Some(err::NOT_EVENT_AUTHORITY));
    // naming Hunch's event authority without its signature: refused
    let mut unsigned = fake.clone();
    unsigned.accounts[0] = AccountMeta::new_readonly(env.event_authority, false);
    assert_eq!(code(env.send_payer(&[env.via_probe(&unsigned)])), Some(err::NOT_EVENT_AUTHORITY));
    // Hunch's own events still land
    let r = env.tick_at(H0 + BAR + 1).unwrap();
    let keys = env.message_keys(&[cu_limit(400_000), env.tick_ix()], &payer);
    assert!(env.events(&r, &keys).iter().any(|(k, _)| *k == event::BAR));
}

// ------------------------------------------------------------------------------------------------
// buys
// ------------------------------------------------------------------------------------------------

#[test]
fn k5_buy_refuses_foreign_accounts_and_bad_timing() {
    let (mut env, t) = running("good", 12, SOL);
    env.donate(2 * SOL);
    let mine = PoolKeys { pool: env.pool().pool, config: env.pool().config, mint: env.pool().mint, base_vault: env.pool().base_vault, quote_vault: env.pool().quote_vault };
    let mine_mint_kp = env.mint_kp.insecure_clone();
    // another DBC pool with the same config numbers, whose creator is also Hunch's budget PDA
    let other = env.create_pool("good", true);
    env.mint_kp = mine_mint_kp;
    // another budget: a stranger with funded WSOL and HUNCH accounts of both mints
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 10 * SOL).unwrap();
    let sk = stranger.insecure_clone();
    env.send(
        &[
            create_ata_ix(&sk.pubkey(), &sk.pubkey(), &wsol_mint()),
            create_ata_ix(&sk.pubkey(), &sk.pubkey(), &mine.mint),
            create_ata_ix(&sk.pubkey(), &env.budget, &other.mint),
            system_transfer(&sk.pubkey(), &ata_of(&sk.pubkey(), &wsol_mint()), 2 * SOL),
            sync_native_ix(&ata_of(&sk.pubkey(), &wsol_mint())),
        ],
        &[&sk],
    )
    .unwrap();
    let fake_token_program = probe_id();
    env.set_clock(H0 + 7200 + 600 + 60, 0);
    let ix = env.buy_ix();
    let swaps: Vec<(usize, &str, Address)> = vec![
        (0, "state: a non-Hunch account", Keypair::new().pubkey()),
        (0, "state: the open call (Hunch's, wrong tag)", env.signal),
        (1, "open call: the tape", env.tape),
        (2, "tape: the diary", env.diary),
        (3, "budget: a stranger", stranger.pubkey()),
        (4, "budget WSOL: a stranger's", ata_of(&stranger.pubkey(), &wsol_mint())),
        (4, "budget WSOL: a trader's", ata_of(&t.pubkey(), &wsol_mint())),
        (5, "budget HUNCH: a stranger's", ata_of(&stranger.pubkey(), &mine.mint)),
        (5, "budget HUNCH: the budget's account of another mint", ata_of(&env.budget, &other.mint)),
        (6, "mint: another pool's", other.mint),
        (7, "WSOL mint: another mint", other.mint),
        (8, "pool: another pool with the same creator", other.pool),
        (9, "config: another config", other.config),
        (10, "base vault: another pool's", other.base_vault),
        (11, "quote vault: another pool's", other.quote_vault),
        (12, "DBC pool authority: a stranger", stranger.pubkey()),
        (13, "DBC event authority: a stranger", stranger.pubkey()),
        (14, "DBC program: another program", probe_id()),
        (15, "token program: another program", fake_token_program),
        (17, "Hunch event authority: a stranger", stranger.pubkey()),
        (18, "Hunch program: another program", probe_id()),
    ];
    let state_before = env.data(&env.state);
    for (slot, what, addr) in &swaps {
        let mut bad = ix.clone();
        bad.accounts[*slot].pubkey = *addr;
        let r = env.send_payer(&[cu_limit(400_000), bad]);
        assert!(r.is_err(), "{what}: accepted");
        assert_eq!(code(r), Some(err::WRONG_ACCOUNT), "{what}");
    }
    let mut bad = ix.clone();
    bad.accounts[16].pubkey = Keypair::new().pubkey();
    assert_eq!(ix_error(env.send_payer(&[cu_limit(400_000), bad])), Some(InstructionError::UnsupportedSysvar));
    assert_eq!(env.data(&env.state), state_before);
    println!("buy: refused {} foreign accounts (all 19 slots) and a fake sysvar", swaps.len());
    // the claim instruction too: the other pool's creator is Hunch's budget, but only Hunch's pool is claimable
    let claim = env.claim_ix();
    for (slot, addr) in [(6usize, other.pool), (4, other.mint), (8, other.base_vault), (9, other.quote_vault), (2, ata_of(&stranger.pubkey(), &wsol_mint()))] {
        let mut bad = claim.clone();
        bad.accounts[slot].pubkey = addr;
        assert_eq!(code(env.send_payer(&[cu_limit(400_000), bad])), Some(err::WRONG_ACCOUNT), "claim slot {slot}");
    }

    // timing: before the hour's boundary tick (bar 18 is the boundary of hour 3 and has not landed)
    for b in 13..=17 {
        bar(&mut env, &t, b, SOL);
    }
    assert_eq!(code(buy_at(&mut env, H0 + 3 * 3600 + 20)), Some(err::NO_BOUNDARY_THIS_HOUR));
    // the hour's boundary lands: by CPI and beside other instructions, refused
    env.tick_at(H0 + 3 * 3600 + 25).unwrap();
    env.set_clock(H0 + 3 * 3600 + 100, 0);
    let ix = env.buy_ix();
    assert_eq!(code(env.send_payer(&[cu_limit(400_000), env.via_probe(&ix)])), Some(err::CALLED_BY_CPI));
    let payer = env.payer.pubkey();
    for (what, ixs) in [
        ("then a memo", vec![cu_limit(400_000), ix.clone(), memo_ix("x")]),
        ("after a transfer", vec![system_transfer(&payer, &t.pubkey(), 1), cu_limit(400_000), ix.clone()]),
        ("twice", vec![cu_limit(800_000), ix.clone(), ix.clone()]),
        ("with read_call", vec![cu_limit(400_000), env.read_call_ix(), ix.clone()]),
    ] {
        assert_eq!(code(env.send_payer(&ixs)), Some(err::NOT_ALONE), "buy {what}");
    }
    let tk = t.insecure_clone();
    let payer_kp = env.payer.insecure_clone();
    let sandwich = [cu_limit(800_000), env.swap_ix(&t.pubkey(), true, SOL, 0), ix.clone(), env.swap_ix(&t.pubkey(), false, 1_000, 0)];
    assert_eq!(code(env.send(&sandwich, &[&payer_kp, &tk])), Some(err::NOT_ALONE), "a sandwich in one transaction");
    // the buy, then a second one in the same hour (even 31 minutes later): refused
    let r = env.send_payer(&[cu_limit(400_000), ix]).unwrap_or_else(|e| panic!("{:?}\n{}", e.err, e.meta.logs.join("\n")));
    assert!(buy_event(&env, &r).is_some());
    assert_eq!(code(buy_at(&mut env, H0 + 3 * 3600 + 120)), Some(err::ALREADY_BOUGHT_THIS_HOUR));
    assert_eq!(code(buy_at(&mut env, H0 + 3 * 3600 + 100 + 1_900)), Some(err::ALREADY_BOUGHT_THIS_HOUR));
    // a ticked next hour, but under 30 minutes since the buy: refused
    for b in 19..=24 {
        bar(&mut env, &t, b, SOL / 2);
    }
    env.set_state(|s| s.last_buy_ts = H0 + 4 * 3600 - 100);
    assert_eq!(code(buy_at(&mut env, H0 + 4 * 3600 + 60)), Some(err::TOO_SOON));
    buy_at(&mut env, H0 + 4 * 3600 + 1_800).unwrap();
}

/// A pump of `pct_tenths` tenths of a percent over the tape's median, then the buy.
fn pump_then_buy(pct_tenths: u32) -> (u64, Option<(u64, u64, u64, u64, u64, u64, u128, u128)>, f64) {
    let (mut env, t) = running("good", 12, SOL);
    env.donate(2 * SOL);
    let med = tape_median(&env);
    let sp = env.pool_sqrt_price();
    let (_, curve, _) = config_curve(&env);
    // sqrt target = median x sqrt(1 + pct)
    let target_f = (med as f64) * (1.0 + pct_tenths as f64 / 1000.0).sqrt();
    let target = target_f as u128;
    assert!(target > sp, "the pump goes up");
    env.set_clock(H0 + 7200 + 300, 0);
    env.trade(&t, true, lamports_to(sp, target, liquidity_at(&curve, sp))).unwrap();
    let spot = env.pool_sqrt_price();
    let ratio = (spot as f64 / med as f64).powi(2);
    let r = buy_at(&mut env, H0 + 7200 + 320).unwrap();
    let st = env.state();
    (st.hs_reason as u64, buy_event(&env, &r), ratio)
}

#[test]
fn k5_the_guard_stops_a_buy_after_a_5_percent_pump() {
    let (reason, ev, ratio) = pump_then_buy(48);
    println!("pump to {:.3}% over the median: reason {reason}, bought {}", (ratio - 1.0) * 100.0, ev.is_some());
    assert!(ratio < 1.05 && ratio > 1.045, "{ratio}");
    assert!(ev.is_some(), "under 5%: it buys");
    let (reason, ev, ratio) = pump_then_buy(52);
    println!("pump to {:.3}% over the median: reason {reason}, bought {}", (ratio - 1.0) * 100.0, ev.is_some());
    assert!(ratio > 1.05 && ratio < 1.055, "{ratio}");
    assert!(ev.is_none() && reason == skip::GUARD as u64, "over 5%: no buy");
}

#[test]
fn k5_min_out_is_enforced_by_dbc() {
    let (mut env, _t) = running("good", 12, SOL);
    env.donate(2 * SOL);
    // the program is made to believe the pool charges no fee: its quote is 3.75% too high, so 99% of it
    // is more than DBC pays out, and DBC must refuse the swap (the whole buy reverts)
    let (cliff, red) = (env.state().cliff_fee, env.state().reduction);
    env.set_state(|s| {
        s.cliff_fee = 0;
        s.reduction = 0;
    });
    let supply = env.mint_supply();
    let held = env.token_amount(&env.budget_wsol);
    let r = buy_at(&mut env, H0 + 7200 + 60);
    let e = r.err().expect("the swap must fail on min_out");
    let logs = e.meta.logs.join("\n");
    assert!(logs.contains("ExceededSlippage") || logs.contains("Slippage"), "DBC's slippage error expected:\n{logs}");
    assert_eq!((env.mint_supply(), env.token_amount(&env.budget_wsol), env.state().buys), (supply, held, 0));
    println!("min_out above what DBC pays: DBC refused the swap, the buy reverted");
    // with the real fee: the min_out DBC receives is 99% of the program's quote, which DBC then pays exactly
    env.set_state(|s| {
        s.cliff_fee = cliff;
        s.reduction = red;
    });
    let r = buy_at(&mut env, H0 + 7200 + 120).unwrap();
    let (_, spent, units, _, _, min_out, ..) = buy_event(&env, &r).unwrap();
    let keys = env.message_keys(&[cu_limit(400_000), env.buy_ix()], &env.payer.pubkey());
    let swap = r
        .inner_instructions
        .iter()
        .flatten()
        .find(|ii| keys[ii.instruction.program_id_index as usize] == dbc() && ii.instruction.data[..8] == SWAP2)
        .expect("swap2");
    let d = &swap.instruction.data;
    assert_eq!((rd_u64(d, 8), rd_u64(d, 16)), (spent, min_out), "amount in and min_out passed to DBC");
    assert_eq!(min_out as u128, units as u128 * 9_900 / 10_000);
}

#[test]
fn k5_post_swap_check_reverts_a_buy_that_moves_the_price_too_far() {
    // the test-only build with a 3% impact cap: its slice moves sqrt_price by more than 1.0101x, so the
    // post-swap check must revert the whole instruction (claim, swap and burn)
    let wide = so_path("HUNCH_WIDE_SO", "deploy-wide/hunch.so");
    let mut env = Env::new_with(H0 - 500, &wide);
    env.launch("good", H0 - 400, H0 - 300);
    let t = env.trader(20_000 * SOL);
    env.tick_at(H0 + 1).unwrap();
    for b in 1..=12 {
        bar(&mut env, &t, b, 20 * SOL);
    }
    env.donate(500 * SOL);
    let day = ((H0 + 7200) / 86_400) as u32;
    env.set_state(|s| {
        s.buy_day = day + 1;
        s.day_cap = 10_000 * SOL;
        s.day_spent = 0;
    });
    let (start, curve, stop) = config_curve(&env);
    let sp = env.pool_sqrt_price();
    let cap1 = rules::impact_cap(sp, start, &curve, stop);
    let supply = env.mint_supply();
    let held = env.token_amount(&env.budget_wsol);
    let r = buy_at(&mut env, H0 + 7200 + 60);
    let e = r.as_ref().err().map(|e| e.meta.logs.join("\n")).unwrap_or_default();
    assert_eq!(code(r), Some(err::PRICE_MOVED_TOO_MUCH), "{e}");
    assert_eq!((env.mint_supply(), env.token_amount(&env.budget_wsol), env.state().buys), (supply, held, 0), "nothing moved");
    println!("wide-cap build: slice above the 1% cap ({cap1} lamports at 1%), sqrt moved past 1.0101x: reverted");
}

#[test]
fn k5_price_move_per_buy_across_segment_boundaries() {
    // the 16-segment curve (liquidity alternating 4:1): for several boundaries, the price is put just under
    // the boundary, an hour of bars runs at that price, then a large budget buys
    let (mut env, t) = running("segments", 6, SOL / 2);
    let (start, curve, stop) = config_curve(&env);
    let mut worst = 0.0f64;
    let mut crossed_n = 0;
    for (k, under_ppm) in [(1i64, 1_000u128), (2, 2_000), (3, 4_000), (4, 500), (5, 8_000)] {
        let sp = env.pool_sqrt_price();
        let i = curve.iter().position(|p| p.sqrt_price > sp).unwrap();
        let boundary = curve[i].sqrt_price;
        let target = boundary - boundary * under_ppm / 1_000_000;
        if target > sp {
            env.set_clock(H0 + k * 3600 + 120, 0);
            env.trade(&t, true, lamports_to(sp, target, curve[i].liquidity)).unwrap();
        }
        for b in (k * 6 + 1)..=(k * 6 + 6) {
            bar(&mut env, &t, b, SOL / 2);
        }
        env.donate(200 * SOL);
        // the day's cap (20% of a small pool's SOL side) would bind first; this test is about the impact cap
        let day = ((H0 + (k + 1) * 3600) / 86_400) as u32;
        env.set_state(|s| {
            s.buy_day = day + 1;
            s.day_cap = 100_000 * SOL;
        });
        let cap = rules::impact_cap(env.pool_sqrt_price(), start, &curve, stop);
        let r = buy_at(&mut env, H0 + (k + 1) * 3600 + 60).unwrap();
        let (_, spent, _, _, _, _, p1, p2) = buy_event(&env, &r).expect("a buy");
        let mv = ((p2 as f64 / p1 as f64).powi(2) - 1.0) * 100.0;
        let crossed = p1 < boundary && p2 > boundary;
        crossed_n += crossed as u32;
        println!(
            "boundary {i}: liquidity {} below, {} above; sqrt {:.4}% under it; spent {spent} (cap {cap}); crossed {crossed}; price +{mv:.4}%",
            curve[i].liquidity,
            curve[i + 1].liquidity,
            (boundary - p1) as f64 / boundary as f64 * 100.0
        );
        assert_eq!(spent, cap);
        assert!(mv <= 2.01, "K5: {mv}%");
        worst = worst.max(mv);
    }
    assert!(crossed_n >= 3, "most buys cross a boundary");
    println!("largest price move of a buy: {worst:.4}% (limit 2.1%)");
}

// ------------------------------------------------------------------------------------------------
// setup griefing and the CPI scan
// ------------------------------------------------------------------------------------------------

/// Every instruction Hunch invoked directly (stack height 2), by program and kind.
fn scan(env: &Env, ixs: &[Instruction], payer: &Address, meta: &TransactionMetadata, seen: &mut BTreeSet<String>) {
    let keys = env.message_keys(ixs, payer);
    for ii in meta.inner_instructions.iter().flatten().filter(|ii| ii.stack_height == 2) {
        let pid = keys[ii.instruction.program_id_index as usize];
        let d = &ii.instruction.data;
        let kind = if pid == dbc() {
            if d[..8] == CLAIM_CREATOR_TRADING_FEE2 {
                "DBC claim_creator_trading_fee2".to_string()
            } else if d[..8] == SWAP2 {
                format!("DBC swap2 mode {}", d[24])
            } else {
                format!("DBC other {:?}", &d[..8])
            }
        } else if pid == token_program() {
            match d[0] {
                17 => "Token sync_native".into(),
                8 => "Token burn".into(),
                k => format!("Token other {k}"),
            }
        } else if pid == memo_program() {
            "Memo".into()
        } else if pid == env.hunch {
            format!("Hunch event {}", d[1])
        } else if pid == system_program() {
            match d[0] {
                0 => "System create_account".into(),
                1 => "System assign".into(),
                2 => "System transfer".into(),
                8 => "System allocate".into(),
                k => format!("System other {k}"),
            }
        } else if pid == ata_program() {
            match d.first() {
                Some(1) => "ATA create_idempotent".into(),
                k => format!("ATA other {k:?}"),
            }
        } else {
            format!("OTHER {pid}")
        };
        seen.insert(kind);
    }
}

#[test]
fn k5_setup_survives_prefunded_pdas_and_the_cpi_scan_covers_every_path() {
    let mut seen = BTreeSet::new();
    let mut env = Env::new(H0 - 500);
    env.set_clock(H0 - 400, 2_000);
    let keys = env.create_pool("good", true);
    // a griefer sends lamports to the PDAs and creates the budget's token accounts before initialize
    let g = Keypair::new();
    env.svm.airdrop(&g.pubkey(), 10 * SOL).unwrap();
    let gk = g.insecure_clone();
    let mut grief: Vec<Instruction> = [env.state, env.model, env.tape, env.signal, env.diary, env.book, env.budget, env.event_authority]
        .iter()
        .map(|a| system_transfer(&gk.pubkey(), a, 1_000_000))
        .collect();
    grief.push(create_ata_ix(&gk.pubkey(), &env.budget, &wsol_mint()));
    grief.push(create_ata_ix(&gk.pubkey(), &env.budget, &keys.mint));
    env.send(&grief, &[&gk]).unwrap();
    let auth = env.authority.insecure_clone();
    let ixs = vec![cu_limit(400_000), env.initialize_ix(&auth.pubkey(), &keys.mint, SEED)];
    let r = env.send(&ixs, &[&auth]).unwrap_or_else(|e| panic!("initialize after griefing: {:?}\n{}", e.err, e.meta.logs.join("\n")));
    scan(&env, &ixs, &auth.pubkey(), &r, &mut seen);
    for a in [env.state, env.model, env.tape, env.signal, env.diary, env.book] {
        let acc = env.svm.get_account(&a).unwrap();
        assert_eq!(acc.owner, env.hunch);
        assert!(acc.lamports >= env.svm.minimum_balance_for_rent_exemption(acc.data.len()));
    }
    env.set_clock(H0 - 300, 2_100);
    let ix = env.adopt_ix(&keys);
    let payer = env.payer.pubkey();
    let r = env.send_payer(&[ix.clone()]).unwrap_or_else(|e| panic!("adopt: {:?}\n{}", e.err, e.meta.logs.join("\n")));
    scan(&env, &[ix], &payer, &r, &mut seen);
    env.pool = Some(keys);
    // a day of ticks and buys (one waits on the guard), claims, the book's growth, a blind tick
    let t = env.trader(1_000 * SOL);
    env.donate(SOL);
    for b in 0..=30i64 {
        if b > 0 {
            env.set_clock(H0 + b * BAR - 300, 0);
            env.churn(&t, SOL);
        }
        env.set_clock(H0 + b * BAR + 1, (b + 10) as u64 * 1000);
        let ixs = vec![cu_limit(400_000), env.tick_ix()];
        let r = env.send_payer(&ixs).unwrap();
        scan(&env, &ixs, &payer, &r, &mut seen);
        if b % 6 == 0 && b >= 12 {
            env.set_clock(H0 + b * BAR + 30, 0);
            if b == 24 {
                env.trade(&t, true, 40 * SOL).unwrap(); // a pump: this buy waits on the guard
            }
            let ixs = vec![cu_limit(400_000), env.buy_ix()];
            let r = env.send_payer(&ixs).unwrap_or_else(|e| panic!("buy {b}: {:?}\n{}", e.err, e.meta.logs.join("\n")));
            scan(&env, &ixs, &payer, &r, &mut seen);
        }
    }
    let ixs = vec![env.claim_ix()];
    let r = env.send_payer(&ixs).unwrap();
    scan(&env, &ixs, &payer, &r, &mut seen);
    env.set_clock(H0 + 70 * 86_400, 0);
    let ixs = vec![env.grow_ix()];
    let r = env.send_payer(&ixs).unwrap();
    scan(&env, &ixs, &payer, &r, &mut seen);
    let pool = env.pool().pool;
    let mut changed = env.svm.get_account(&pool).unwrap();
    changed.data[0] ^= 0xff;
    env.svm.set_account(pool, changed).unwrap();
    env.set_clock(H0 + 70 * 86_400 + 1, 0);
    let ixs = vec![cu_limit(400_000), env.tick_ix()];
    let r = env.send_payer(&ixs).unwrap();
    scan(&env, &ixs, &payer, &r, &mut seen);
    // a partial fill that completes a small curve
    let (mut env2, t2) = running("small", 6, SOL / 10);
    let threshold = rd_u64(&env2.data(&env2.pool().config), config::MIGRATION_QUOTE_THRESHOLD);
    env2.set_clock(H0 + 3600 + 700, 0);
    for _ in 0..20 {
        let reserve = rd_u64(&env2.data(&env2.pool().pool), pool::QUOTE_RESERVE);
        if threshold - reserve < SOL / 20 {
            break;
        }
        let gross = ((threshold - reserve - SOL / 40) as u128 * 1_000_000_000 / (1_000_000_000 - 37_500_000)) as u64;
        env2.trade(&t2, true, gross).unwrap();
    }
    for b in 7..=12 {
        bar(&mut env2, &t2, b, SOL / 500);
    }
    env2.donate(50 * SOL);
    env2.set_clock(H0 + 7200 + 60, 0);
    let ixs = vec![cu_limit(400_000), env2.buy_ix()];
    let p2 = env2.payer.pubkey();
    let r = env2.send_payer(&ixs).unwrap();
    scan(&env2, &ixs, &p2, &r, &mut seen);

    println!("every instruction Hunch invoked: {seen:#?}");
    let allowed = [
        "ATA create_idempotent",
        "DBC claim_creator_trading_fee2",
        "DBC swap2 mode 0",
        "DBC swap2 mode 1",
        "Hunch event 1",
        "Hunch event 2",
        "Hunch event 3",
        "Hunch event 4",
        "Hunch event 5",
        "Memo",
        "System allocate",
        "System assign",
        "System create_account",
        "System transfer",
        "Token burn",
        "Token sync_native",
    ];
    for k in &seen {
        assert!(allowed.contains(&k.as_str()), "unexpected CPI: {k}");
    }
    for k in ["DBC swap2 mode 0", "DBC swap2 mode 1", "Token burn", "Memo", "System allocate", "Hunch event 5"] {
        assert!(seen.contains(k), "the scan did not reach {k}");
    }
}

// ------------------------------------------------------------------------------------------------
// K4: the worst cases
// ------------------------------------------------------------------------------------------------

#[test]
fn k4_worst_case_compute_and_transaction_sizes() {
    // (1) the longest diary line (240 bytes: 10-digit counters, the guard's excess, the most SOL a line can
    // hold), at a boundary that also changes chapter and writes the day's record and weights
    let (mut env, t) = running("good", 23, SOL);
    let hh = ((H0 + 24 * BAR) / 3600) as u32;
    env.set_state(|s| {
        s.launch_hour = 0; // chapter 3 starts at this boundary, and the hour has 6 digits
        s.chapter = 0;
        s.n = 4_000_000_000;
        s.hits = 3_999_999_999;
        s.rule_hits = 3_999_999_998;
        s.hs_hour = hh - 1;
        s.hs_reason = skip::GUARD;
        s.hs_detail = 255;
        s.hs_held = u32::MAX as u64 * 10_000;
        s.last_record_day = 0;
    });
    env.set_clock(H0 + 24 * BAR - 300, 0);
    env.churn(&t, SOL);
    let r = env.tick_at(H0 + 24 * BAR + 29).unwrap();
    let cu = hunch_cu(&r.logs).unwrap();
    let m = memos(&r.logs);
    println!("longest boundary: {cu} CU, memo {} bytes: {}", m[0].len(), m[0]);
    println!("  chapter memo: {}", m.get(1).cloned().unwrap_or_default());
    assert!(m[0].len() >= 215 && m.len() == 2, "{m:?}");
    assert!(cu <= 200_000, "K4: boundary tick {cu} CU");
    // (2) an ordinary tick that is the day's first (the 00:00 boundary was missed): it trains, thinks,
    // fills, writes the day's record and emits the weights; once after 1 missed bar, once after 13
    let mut env = Env::new(0);
    for missed in [1i64, 13] {
        let (mut e, t) = running("good", 54 - missed, SOL / 10);
        // chapter 3 (both layers learn, the costliest step); H0 is 15:00 UTC: bar 54 is 00:00 (missed),
        // bar 55 is 00:10 (ordinary)
        e.set_state(|s| s.chapter = 3);
        e.set_clock(H0 + 55 * BAR - 300, 0);
        e.churn(&t, SOL);
        let r = e.tick_at(H0 + 55 * BAR + 29).unwrap();
        let cu = hunch_cu(&r.logs).unwrap();
        let flags = rd_u16(&e.last_tape(), 6);
        println!("ordinary tick, the day's first, after {missed} missed bar(s): {cu} CU (tape flags {flags:#b})");
        assert!(flags & rules::tf::GAP != 0 && flags & rules::tf::DAY_RECORD != 0 && flags & rules::tf::BOUNDARY == 0);
        assert!(cu <= 60_000, "K4: ordinary tick {cu} CU");
        env = e;
    }
    // (3) sizes with both ComputeBudget instructions
    let p = env.payer.pubkey();
    let tick = wire_size(&[cu_limit(400_000), cu_price(1), env.tick_ix()], &p);
    let buy = wire_size(&[cu_limit(400_000), cu_price(1), env.buy_ix()], &p);
    println!("transaction sizes with a CU limit and a CU price: tick {tick} bytes, buy {buy} bytes (limit 1,232)");
    assert!(tick <= 1232 && buy <= 1232);
}

// ------------------------------------------------------------------------------------------------
// K7 in the program: a missed tick in the hour before a call forfeits that call
// ------------------------------------------------------------------------------------------------

#[test]
fn k7_a_missed_ordinary_tick_forfeits_the_next_call_and_the_diary_keeps_the_buy() {
    let (mut env, t) = running("good", 28, SOL);
    // bar 29 (the ordinary bar before hour 5's boundary) is missed; bar 30 lands: no call for hour 5
    env.set_clock(H0 + 29 * BAR - 300, 0);
    env.churn(&t, SOL);
    bar(&mut env, &t, 30, SOL);
    let s = env.signal_bytes();
    assert_eq!(s[sig::CALL], rules::call::NONE, "no call after a gap in the hour before it");
    assert!(s[sig::FLAGS] & rules::sf::GAP != 0);
    assert_eq!(s[sig::RULE], rules::call::NONE);
    // the hour's boundary landed, so Hunch still buys in it
    env.donate(SOL);
    let r = buy_at(&mut env, H0 + 5 * 3600 + 120).unwrap();
    let (_, spent, units, ..) = buy_event(&env, &r).expect("a buy in the hour without a call");
    let before = env.state();
    for b in 31..=36 {
        bar(&mut env, &t, b, SOL);
    }
    let st = env.state();
    let e = Entry::read(&env.last_diary());
    let text = String::from_utf8(hunch::format::diary_line(&e, b"HUNCH").as_bytes().to_vec()).unwrap();
    println!("{text}");
    assert_eq!((e.outcome, e.detail, e.bought, e.burned), (rules::outcome::FORFEIT, 1, spent, units));
    assert_eq!((st.n, st.forfeits, st.hits), (before.n + 1, before.forfeits + 1, before.hits));
    assert!(text.contains("forfeit, a tick was missed.") && text.contains(" bought ") && !text.contains("opening tick"), "{text}");
    // the same with a buy that waits on the guard: the line names the excess, not "forfeit x<excess>"
    for b in 37..=40 {
        bar(&mut env, &t, b, SOL);
    }
    env.set_clock(H0 + 41 * BAR - 300, 0);
    env.churn(&t, SOL);
    bar(&mut env, &t, 42, SOL); // bar 41 missed
    assert_eq!(env.signal_bytes()[sig::CALL], rules::call::NONE);
    env.set_clock(H0 + 7 * 3600 + 100, 0);
    env.trade(&t, true, 40 * SOL).unwrap();
    buy_at(&mut env, H0 + 7 * 3600 + 120).unwrap();
    let excess = env.state().hs_detail;
    assert_eq!(env.state().hs_reason, skip::GUARD);
    for b in 43..=48 {
        bar(&mut env, &t, b, SOL);
    }
    let e = Entry::read(&env.last_diary());
    let text = String::from_utf8(hunch::format::diary_line(&e, b"HUNCH").as_bytes().to_vec()).unwrap();
    println!("{text}");
    assert_eq!((e.outcome, e.detail), (rules::outcome::FORFEIT, excess));
    assert!(text.contains("forfeit, a tick was missed.") && text.contains(&format!("no buy: price {}.{}% over its hour median", excess / 10, excess % 10)), "{text}");
}

#[test]
fn initialize_takes_only_canonical_bumps_so_there_is_one_hunch() {
    // before the fix the upgrade authority could initialize a second Hunch at non-canonical PDAs (its own
    // state, budget and diary), and tick and the buys, which check the state by owner and tag, would
    // accept it as well
    let mut env = Env::new(H0 - 500);
    env.set_clock(H0 - 400, 2_000);
    let keys = env.create_pool("good", true);
    let r = env.initialize(&keys.mint, SEED).unwrap();
    println!("initialize: {} CU", hunch_cu(&r.logs).unwrap());
    let seeds: [&[u8]; 8] = [b"state", b"model", b"tape", b"signal", b"diary", b"brains", b"budget", b"__event_authority"];
    let mut other = env.bumps;
    let mut addrs = vec![];
    for (k, s) in seeds.iter().enumerate() {
        let canonical = env.bumps[k + 1];
        let b = (0..canonical).rev().find(|b| Address::create_program_address(&[s, &[*b]], &env.hunch).is_ok()).unwrap();
        other[k + 1] = b;
        addrs.push(Address::create_program_address(&[s, &[b]], &env.hunch).unwrap());
    }
    let auth = env.authority.insecure_clone();
    let mut ix = env.initialize_ix(&auth.pubkey(), &keys.mint, SEED);
    for (k, a) in addrs.iter().enumerate().take(6) {
        ix.accounts[2 + k].pubkey = *a; // state, model, tape, signal, diary, book
    }
    ix.accounts[8].pubkey = addrs[6]; // budget
    ix.accounts[9].pubkey = ata_of(&addrs[6], &wsol_mint());
    ix.accounts[14].pubkey = addrs[7]; // event authority
    ix.data[37..46].copy_from_slice(&other); // the bumps (the ticker follows them)
    let r = env.send(&[cu_limit(400_000), ix], &[&auth]);
    assert_eq!(ix_error(r), Some(InstructionError::InvalidSeeds));
    assert!(env.svm.get_account(&addrs[0]).map(|a| a.owner != env.hunch).unwrap_or(true), "no second state");
}

#[test]
fn blind_bars_are_not_missed_ticks() {
    // the pool goes blind for three bars across hour 4's boundary (a Meteora layout change, not a cranker):
    // the gap rule must not forfeit the next call for it, and the blind hour is not scored
    let mut env = launched("good");
    let t = env.trader(1_000 * SOL);
    env.tick_at(H0 + 1).unwrap();
    for b in 1..=23 {
        bar(&mut env, &t, b, SOL / 4 * (1 + (b as u64 * 7) % 5));
    }
    let before = env.state();
    let pool = env.pool().pool;
    let good = env.svm.get_account(&pool).unwrap();
    let mut changed = good.clone();
    changed.data[0] ^= 0xff;
    env.svm.set_account(pool, changed).unwrap();
    for b in 24..=26 {
        env.tick_at(H0 + b * BAR + 1).unwrap();
    }
    env.svm.set_account(pool, good).unwrap();
    for b in 27..=30 {
        bar(&mut env, &t, b, SOL / 4 * (1 + (b as u64 * 7) % 5));
    }
    let s = env.signal_bytes();
    assert!(s[sig::FLAGS] & rules::sf::GAP == 0, "blind bars are not a gap");
    assert_ne!(s[sig::CALL], rules::call::NONE, "hour 5 has its call");
    for b in 31..=36 {
        bar(&mut env, &t, b, SOL / 4 * (1 + (b as u64 * 7) % 5));
    }
    assert_eq!(env.state().forfeits, before.forfeits, "no forfeit for a blind spell");
}
