//! Upgrade compatibility against the LIVE program: the accounts of Pooter's program on mainnet (state,
//! model, tape, open call, diary, brain book, the budget's WSOL and coin accounts, the DBC pool, its config,
//! vaults and mint), cloned read-only through the public RPC by programs/tests/clone-live.mjs, with the NEW
//! binary loaded at the live program id (CCw2e4...hPaY1) and Meteora DBC's 0.2.2 mainnet bytecode. The
//! ProgramData's upgrade authority is REWRITTEN in the clone to a throwaway key, a stand-in for the
//! developer's wallet (whose key the tests never have).
//! Steps, each tick and hourly buy compared byte for byte with the deployed build (face57dd...,
//! OLD_HUNCH_SO) run from the very same accounts: the ticks up to and including the next hour's boundary and
//! that hour's buy_and_burn_curve; then withdraw_budget signed by the stand-in; then trades, the ticks to the
//! following boundary and that hour's buy, on the fees that arrived after the withdrawal.
//! LIVE_ACCOUNTS names the clone (default $HUNCH_TARGET/live-clone, else ~/hunch-target/live-clone);
//! without a clone the test says so and passes (test-v1.sh makes one first).

use {
    hunch::{format::withdraw_line, layout::*, rules},
    hunch_tests::*,
    litesvm::types::FailedTransactionMetadata,
    solana_address::Address,
    solana_clock::Clock,
    solana_signer::Signer,
};

const SOL: f64 = 1e9;

fn ok(r: Result<TransactionMetadata, FailedTransactionMetadata>, what: &str) -> TransactionMetadata {
    r.unwrap_or_else(|e| panic!("{what}: {:?}\n{}", e.err, e.meta.logs.join("\n")))
}
fn clock_to(env: &mut Env, ts: i64, base_ts: i64, base_slot: u64) {
    let mut c: Clock = env.svm.get_sysvar();
    c.unix_timestamp = ts;
    c.slot = base_slot + ((ts - base_ts).max(0) as u64) * 5 / 2;
    env.svm.set_sysvar(&c);
}

/// Ticks both worlds bar by bar from `bar` up to and including the next hour boundary, comparing each tick.
/// Returns the boundary bar and how many ticks ran.
fn tick_to_boundary(a: &mut Env, b: &mut Env, mut bar: u32, base: (i64, u64), watched: &[Address]) -> (u32, u32) {
    let mut ticks = 0;
    loop {
        let ts = bar as i64 * 600 + 1;
        for e in [&mut *a, &mut *b] {
            clock_to(e, ts, base.0, base.1);
        }
        let ra = ok(a.tick(), &format!("tick bar {bar} (new build)"));
        let rb = ok(b.tick(), &format!("tick bar {bar} (deployed build)"));
        assert_eq!(a.differences(b, watched), Vec::<Address>::new(), "tick of bar {bar} differs from the deployed build");
        assert_eq!(memos(&ra.logs), memos(&rb.logs));
        ticks += 1;
        if bar % 6 == 0 {
            println!("boundary tick at {ts} (bar {bar}): {:?}, {} CU (transaction)", memos(&ra.logs), ra.compute_units_consumed);
            return (bar, ticks);
        }
        bar += 1;
    }
}

/// The hourly buy in both worlds at `t`, compared byte for byte. Returns whether it bought.
fn hourly_both(a: &mut Env, b: &mut Env, t: i64, base: (i64, u64), watched: &[Address], what: &str) -> bool {
    for e in [&mut *a, &mut *b] {
        clock_to(e, t, base.0, base.1);
    }
    let held_before = a.token_amount(&a.budget_wsol);
    let ra = a.buy();
    let rb = b.buy();
    assert_eq!(ra.is_ok(), rb.is_ok(), "{what}: the two builds disagree: {:?} / {:?}", ra.as_ref().err().map(|e| &e.err), rb.as_ref().err().map(|e| &e.err));
    assert_eq!(a.differences(b, watched), Vec::<Address>::new(), "{what}: differs from the deployed build");
    let st = a.state();
    let bought = st.last_buy_hour == (t / 3600) as u32;
    println!(
        "{what} at {t}: {} ({:.6} SOL of {:.6} held; WSOL before the claim {:.6}; reason {}), byte for byte as the deployed build",
        if bought { "bought" } else { "waited" },
        st.hs_bought as f64 / SOL,
        st.hs_held as f64 / SOL,
        held_before as f64 / SOL,
        st.hs_reason
    );
    bought
}

#[test]
fn the_new_build_runs_on_the_live_accounts() {
    let dir = std::env::var("LIVE_ACCOUNTS")
        .unwrap_or_else(|_| format!("{}/live-clone", std::env::var("HUNCH_TARGET").unwrap_or_else(|_| format!("{}/hunch-target", std::env::var("HOME").unwrap()))));
    let new_so = so_path("HUNCH_SO", "deploy/hunch.so");
    let Some((mut a, index)) = Env::from_live(&dir, &new_so) else {
        println!("SKIPPED: no live clone in {dir} (run node hunch/programs/tests/clone-live.mjs)");
        return;
    };
    let base = (index["unix_timestamp"].as_i64().unwrap(), index["slot"].as_u64().unwrap());
    let st0 = a.state();
    println!(
        "live clone of {} at slot {} ({}): phase {}, {} ticks, {} buys, {:.6} SOL spent, ticker {}; the ProgramData's upgrade authority rewritten to a throwaway stand-in {}",
        index["program"].as_str().unwrap(),
        base.1,
        index["cloned_at"].as_str().unwrap(),
        st0.phase,
        st0.ticks,
        st0.buys,
        st0.spent as f64 / SOL,
        String::from_utf8_lossy(ticker_of(&st0)),
        a.authority.pubkey()
    );
    assert_eq!(st0.phase, rules::phase::CURVE, "this test covers the curve phase (the live coin's phase on 2026-10-20)");
    assert_eq!((st0.withdrawn, st0.withdrawals, st0.last_withdraw_hour, st0.reserved), (0, 0, 0, [0, 0]), "the reserve the new fields use is zero on the live State");
    assert_eq!(a.budget_hunch(), Address::new_from_array(st0.budget_hunch), "the clone's addresses agree with the PDAs");
    let mut watched = a.watched();
    watched.retain(|k| *k != a.authority.pubkey());

    // ---- the ticks to the next boundary and the hourly buy: the new build against the deployed one ----
    let mut b = a.twin(Some(&old_so()));
    let (mut bar, mut ticks) = tick_to_boundary(&mut a, &mut b, st0.last_attempt_bar + 1, base, &watched);
    // the hourly buy, at least 30 minutes after the live coin's last buy, with a fresh tape
    let mut t_buy = bar as i64 * 600 + 60;
    while t_buy < a.state().last_buy_ts + 1_801 {
        bar += 1;
        for e in [&mut a, &mut b] {
            clock_to(e, bar as i64 * 600 + 1, base.0, base.1);
        }
        ok(a.tick(), "tick (new)");
        ok(b.tick(), "tick (deployed)");
        ticks += 1;
        t_buy = bar as i64 * 600 + 40;
    }
    println!("{ticks} ticks before the first hourly buy");
    let first = hourly_both(&mut a, &mut b, t_buy, base, &watched, "the hourly buy");

    // ---- withdraw_budget, signed by the stand-in for the upgrade authority ----
    let t_w = t_buy + 30;
    clock_to(&mut a, t_w, base.0, base.1);
    let auth = a.authority.pubkey();
    let rent = a.svm.minimum_balance_for_rent_exemption(165);
    let wsol_lamports = a.svm.get_account(&a.budget_wsol).unwrap().lamports;
    let rent_reserve = rd_u64(&a.data(&a.budget_wsol), 109 + 4); // is_native: Some(reserve)
    let wsol = wsol_lamports - rent_reserve;
    let p = a.pool().pool;
    let pool_u64 = |e: &Env, at: usize| rd_u64(&e.data(&p), at);
    let (creator0, partner0, protocol0) = (pool_u64(&a, pool::CREATOR_QUOTE_FEE), pool_u64(&a, POOL_PARTNER_QUOTE_FEE), pool_u64(&a, POOL_PROTOCOL_QUOTE_FEE));
    let reserves0 = (pool_u64(&a, pool::BASE_RESERVE), pool_u64(&a, pool::QUOTE_RESERVE), a.pool_sqrt_price());
    let dev0 = a.svm.get_account(&auth).unwrap().lamports;
    let supply0 = a.mint_supply();
    let raw0 = a.data(&a.state);
    let r = ok(a.withdraw(0), "withdraw_budget on the live accounts");
    let ev = a.withdraw_event(&r).expect("event 6");
    println!(
        "withdraw_budget: {:.6} SOL in the budget's WSOL + {:.6} creator fee claimed = {:.6} SOL to the stand-in's wallet; {} CU; rent reserve of the budget's WSOL account {} lamports (local rent {rent})",
        wsol as f64 / SOL,
        ev.claimed as f64 / SOL,
        ev.amount as f64 / SOL,
        r.compute_units_consumed,
        rent_reserve
    );
    println!("memo: {:?}", memos(&r.logs));
    assert_eq!(ev.claimed, creator0);
    assert_eq!(ev.amount, wsol + creator0, "the budget's WSOL + the creator fee claimed, exactly");
    assert_eq!(a.token_amount(&a.budget_wsol), 0);
    assert_eq!(a.svm.get_account(&auth).unwrap().lamports, dev0 + ev.amount - 5_000, "the stand-in received the amount, less the network fee");
    assert_eq!((pool_u64(&a, POOL_PARTNER_QUOTE_FEE), pool_u64(&a, POOL_PROTOCOL_QUOTE_FEE)), (partner0, protocol0), "the developer's partner fee and the protocol fee are untouched");
    assert_eq!((pool_u64(&a, pool::BASE_RESERVE), pool_u64(&a, pool::QUOTE_RESERVE), a.pool_sqrt_price()), reserves0, "the pool's reserves and price");
    assert_eq!(a.mint_supply(), supply0);
    println!("the developer's DBC partner fee, untouched: {:.6} SOL", partner0 as f64 / SOL);
    let want = String::from_utf8(withdraw_line(ev.amount, ticker_of(&a.state())).as_bytes().to_vec()).unwrap();
    assert_eq!(memos(&r.logs), vec![want]);
    let st = a.state();
    assert_eq!((st.withdrawn, st.withdrawals, st.last_withdraw_hour), (ev.amount, 1, (t_w / 3600) as u32));
    let raw = a.data(&a.state);
    let claimed_at = std::mem::offset_of!(State, claimed);
    for i in (0..STATE_LEN).filter(|i| !(1216..1232).contains(i) && !(claimed_at..claimed_at + 8).contains(i)) {
        assert_eq!(raw[i], raw0[i], "State byte {i} changed");
    }

    // ---- trades after the withdrawal, the ticks to the next boundary and that hour's buy, on the new fees ----
    let t = a.trader(50_000_000_000);
    clock_to(&mut a, t_w + 60, base.0, base.1);
    a.churn(&t, 10_000_000_000);
    println!("after the withdrawal, a 10 SOL round trip: {:.6} SOL of new creator fee", pool_u64(&a, pool::CREATOR_QUOTE_FEE) as f64 / SOL);
    let mut b = a.twin(Some(&old_so()));
    let mut watched = watched.clone();
    watched.extend([ata_of(&t.pubkey(), &wsol_mint()), ata_of(&t.pubkey(), &a.pool().mint)]);
    let (next, _) = tick_to_boundary(&mut a, &mut b, (t_w / 600) as u32 + 1, base, &watched);
    let second = hourly_both(&mut a, &mut b, next as i64 * 600 + 60, base, &watched, "the next hour's hourly buy, after the withdrawal");
    assert!(second, "the hourly buy after the withdrawal bought, from the fees that came after it");
    let st = a.state();
    assert_eq!(st.buys, st0.buys + first as u32 + 1);
    assert_eq!((st.withdrawn, st.withdrawals), (ev.amount, 1));
}
