//! withdraw_budget, the developer's withdrawal, on the curve, against Meteora DBC's real bytecode: only the
//! upgrade authority can make it, and never by CPI; it moves exactly the budget's WSOL plus the creator fee it
//! claims in the same instruction, and nothing else (DBC's partner and protocol fees, the pool's reserves and
//! the coin's supply stay as they were; the developer's wallet gains that amount less the network fee once
//! the script unwraps it); its totals, event and memo; the refusals; and the hourly buy_and_burn_curve, in the
//! same hour and the next ones, doing byte for byte what the deployed build (~/hunch-target/final/hunch.so,
//! OLD_HUNCH_SO) does from the same accounts, on the fees that arrive after the withdrawal.

use {
    hunch::{format::withdraw_line, ids::err, layout::*, rules::phase},
    hunch_tests::*,
    litesvm::types::FailedTransactionMetadata,
    solana_address::Address,
    solana_instruction_error::InstructionError,
    solana_keypair::Keypair,
    solana_signer::Signer,
    solana_transaction_error::TransactionError,
    std::collections::BTreeSet,
};

const H0: i64 = 1_790_002_800; // a UTC hour start
const SOL: u64 = 1_000_000_000;
const BAR: i64 = 600;
const SIG_FEE: u64 = 5_000;

fn code<T>(r: Result<T, FailedTransactionMetadata>) -> Option<u32> {
    r.err().and_then(|e| custom_code(&e))
}
fn ok(r: Result<TransactionMetadata, FailedTransactionMetadata>, what: &str) -> TransactionMetadata {
    r.unwrap_or_else(|e| panic!("{what}: {:?}\n{}", e.err, e.meta.logs.join("\n")))
}

/// A launched pool, the baseline tick at H0, then `bars` more bars each with a round trip of `churn`
/// lamports by a trader before its tick (at second 1). The clock ends on the last tick.
fn running(bars: i64, churn: u64) -> (Env, Keypair) {
    let mut env = Env::new(H0 - 500);
    env.launch("good", H0 - 400, H0 - 300);
    let t = env.trader(5_000 * SOL);
    env.tick_at(H0 + 1).unwrap();
    for b in 1..=bars {
        bar(&mut env, &t, b, churn);
    }
    (env, t)
}
fn bar(env: &mut Env, t: &Keypair, b: i64, churn: u64) {
    if churn > 0 {
        env.set_clock(H0 + b * BAR - 300, 0);
        env.churn(t, churn);
    }
    env.tick_at(H0 + b * BAR + 1).unwrap_or_else(|e| panic!("tick bar {b}: {:?}\n{}", e.err, e.meta.logs.join("\n")));
}
fn at(env: &mut Env, ts: i64) {
    env.set_clock(ts, (ts - 1_700_000_000) as u64);
}
fn hourly(env: &mut Env, ts: i64) -> Result<TransactionMetadata, FailedTransactionMetadata> {
    at(env, ts);
    env.buy()
}
fn lamports(env: &Env, a: &Address) -> u64 {
    env.svm.get_account(a).map(|x| x.lamports).unwrap_or(0)
}
fn pool_u64(env: &Env, at: usize) -> u64 {
    rd_u64(&env.data(&env.pool().pool), at)
}
fn text(b: &[u8]) -> String {
    String::from_utf8(b.to_vec()).unwrap()
}

/// Every instruction Hunch invoked directly (stack height 2) in a transaction made of `ixs` paid by `payer`.
fn scan(env: &Env, ixs: &[solana_instruction::Instruction], payer: &Address, meta: &TransactionMetadata) -> BTreeSet<String> {
    let keys = env.message_keys(ixs, payer);
    let mut seen = BTreeSet::new();
    // only Hunch's own instruction's inner instructions (the WSOL account's creation has its own)
    let at = ixs.iter().position(|ix| ix.program_id == env.hunch).unwrap();
    for ii in meta.inner_instructions[at].iter().filter(|ii| ii.stack_height == 2) {
        let pid = keys[ii.instruction.program_id_index as usize];
        let d = &ii.instruction.data;
        seen.insert(if pid == dbc() && d[..8] == hunch::ids::CLAIM_CREATOR_TRADING_FEE2 {
            "DBC claim_creator_trading_fee2".to_string()
        } else if pid == damm() && d[..8] == hunch::ids::DAMM_CLAIM_POSITION_FEE {
            "DAMM v2 claim_position_fee".to_string()
        } else if pid == token_program() && d[0] == 17 {
            "Token sync_native".into()
        } else if pid == token_program() && d[0] == 3 {
            "Token transfer".into()
        } else if pid == memo_program() {
            "Memo".into()
        } else if pid == env.hunch {
            format!("Hunch event {}", d[1])
        } else {
            format!("OTHER {pid} {:?}", &d[..d.len().min(8)])
        });
    }
    seen
}

/// The State fields that differ between two States, by name: every field of the struct.
fn state_changes(a: &State, b: &State) -> Vec<&'static str> {
    let mut out = vec![];
    macro_rules! cmp {
        ($($f:ident),*) => { $( if a.$f != b.$f { out.push(stringify!($f)); } )* };
    }
    cmp!(
        tag, version, phase, chapter, brain_source, budget_bump, event_bump, last_outcome, blind, mint, pool, config, base_vault,
        quote_vault, budget, budget_wsol, budget_hunch, model, tape, signal, diary, book, event_authority, brain_hash, seed,
        launch_hour, launch_ts, activation_point, cliff_fee, reduction, period_frequency, n_periods, migration_quote_threshold,
        ticks, last_tick_ts, last_tick_bar, start_hour, last_sp, last_fee_total, cum, own_fee, own_ratio, own_lamports,
        last_attempt_bar, blind_until_hour, last_boundary_hour, recent_len, last_boundary_ts, last_boundary_cum, ref_vol,
        ref_secs, hour_vol_prev, recent_bits, last_record_day, n, hits, rule_hits, busier_hours, quieter_calls, quieter_hits,
        forfeits, not_scored, last_buy_hour, buy_day, last_buy_ts, day_buys, hs_reason, hs_detail, pad0, day_spent, day_cap,
        hs_hour, pad1, hs_bought, hs_burned, hs_held, spent, bought_units, burned, donated, buys, skips, claimed,
        last_missed_bar, pad2, damm_pool, damm_config, token_a_vault, token_b_vault, position, position_nft, position_mint,
        last_liquidity, adopt_fee_fp, last_fee_fp, adopt_fee_num, surplus, pool_claimed, adopt_ts, adopt_hour, pool_warm_end,
        prev_n, prev_hits, prev_rule_hits, prev_forfeits, prev_not_scored, last_status, dist_cur, dist_prev, grad_line, ticker,
        migration_sqrt_price, withdrawn, withdrawals, last_withdraw_hour, reserved
    );
    out
}
/// What withdraw_budget may write in State on the curve.
const WITHDRAW_WRITES: [&str; 4] = ["claimed", "withdrawn", "withdrawals", "last_withdraw_hour"];

#[test]
fn the_withdrawal_moves_the_budget_and_the_fee_it_claims_and_nothing_else() {
    // two hours of 1 SOL round trips: the creator fee accrues on DBC; 2 SOL sent straight to the budget's
    // WSOL account (not yet synced) joins the budget
    let (mut env, _t) = running(12, SOL);
    env.donate(2 * SOL);
    let when = H0 + 7200 + 900;
    at(&mut env, when);
    let auth = env.authority.pubkey();
    let rent = env.svm.minimum_balance_for_rent_exemption(165);
    let wsol_before = lamports(&env, &env.budget_wsol) - rent;
    let creator_before = pool_u64(&env, pool::CREATOR_QUOTE_FEE);
    let partner_before = pool_u64(&env, POOL_PARTNER_QUOTE_FEE);
    let protocol_before = pool_u64(&env, POOL_PROTOCOL_QUOTE_FEE);
    let reserves_before = (pool_u64(&env, pool::BASE_RESERVE), pool_u64(&env, pool::QUOTE_RESERVE), env.pool_sqrt_price());
    let quote_vault_before = env.token_amount(&env.pool().quote_vault);
    let base_vault_before = env.token_amount(&env.pool().base_vault);
    let coin_before = env.data(&env.budget_hunch());
    let dev_before = lamports(&env, &auth);
    let supply_before = env.mint_supply();
    let st0 = env.state();
    let raw0 = env.data(&env.state);
    let sg0 = env.signal_bytes();
    let (tape0, diary0, model0, book0) = (env.data(&env.tape), env.data(&env.diary), env.data(&env.model), env.data(&env.book));
    assert!(wsol_before >= 2 * SOL && creator_before > 0, "a budget to withdraw: {wsol_before} in WSOL, {creator_before} creator fee");
    assert_eq!((st0.withdrawn, st0.withdrawals, st0.last_withdraw_hour, st0.reserved), (0, 0, 0, [0, 0]));

    let ixs = env.withdraw_ixs(0);
    let r = ok(env.withdraw(0), "withdraw_budget");
    let ev = env.withdraw_event(&r).expect("event 6");
    let cu = hunch_cu(&r.logs).unwrap();
    println!(
        "withdraw_budget: {:.6} SOL ({:.6} in the budget's WSOL, sent straight there and not yet synced, + {:.6} creator fee claimed), {cu} CU, {} bytes (with the WSOL account's creation and closing)",
        ev.amount as f64 / 1e9,
        wsol_before as f64 / 1e9,
        ev.claimed as f64 / 1e9,
        wire_size(&ixs, &auth)
    );

    // ---- exactly the budget's WSOL plus the creator fee claimed in the same instruction ----
    assert_eq!(ev.claimed, creator_before, "the claim took the whole creator fee DBC held");
    assert_eq!((ev.held, ev.amount, ev.left), (wsol_before + creator_before, wsol_before + creator_before, 0));
    assert_eq!((ev.total, ev.count, ev.signer), (ev.amount, 1, auth));
    assert_eq!(env.token_amount(&env.budget_wsol), 0);
    assert_eq!(lamports(&env, &env.budget_wsol), rent, "only the account's rent stays; the account stays open");
    // ---- the developer's wallet: that amount, less the network fee (the WSOL account's rent comes back on closing) ----
    assert_eq!(lamports(&env, &auth), dev_before + ev.amount - SIG_FEE, "the developer receives the amount, less the transaction fee");
    assert!(env.svm.get_account(&env.dev_wsol()).map(|a| a.lamports == 0).unwrap_or(true), "the developer's WSOL account is closed");
    // ---- DBC: partner and protocol fees untouched, the reserves untouched; the quote vault lost the creator fee only ----
    assert_eq!(pool_u64(&env, POOL_PARTNER_QUOTE_FEE), partner_before, "the developer's own partner fee is not touched");
    assert_eq!(pool_u64(&env, POOL_PROTOCOL_QUOTE_FEE), protocol_before, "Meteora's protocol fee is not touched");
    assert_eq!(pool_u64(&env, pool::CREATOR_QUOTE_FEE), 0);
    assert_eq!((pool_u64(&env, pool::BASE_RESERVE), pool_u64(&env, pool::QUOTE_RESERVE), env.pool_sqrt_price()), reserves_before, "the pool's reserves and price");
    assert_eq!(quote_vault_before - env.token_amount(&env.pool().quote_vault), creator_before, "the quote vault paid the creator fee and nothing more");
    assert_eq!(env.token_amount(&env.pool().base_vault), base_vault_before);
    // ---- the coin: nothing bought, nothing burned, the budget's coin account untouched ----
    assert_eq!(env.mint_supply(), supply_before);
    assert_eq!(env.data(&env.budget_hunch()), coin_before);
    // ---- State: only the withdrawal's fields and the claim; every other byte as it was ----
    let st = env.state();
    let changed = state_changes(&st0, &st);
    for f in &changed {
        assert!(WITHDRAW_WRITES.contains(f), "withdraw_budget changed {f}");
    }
    assert_eq!((st.withdrawn, st.withdrawals, st.last_withdraw_hour), (ev.amount, 1, (when / 3600) as u32));
    assert_eq!(st.claimed - st0.claimed, ev.claimed);
    assert_eq!((st.spent, st.burned, st.buys, st.day_spent, st.hs_hour, st.hs_bought, st.skips), (st0.spent, st0.burned, st0.buys, st0.day_spent, st0.hs_hour, st0.hs_bought, st0.skips));
    let raw = env.data(&env.state);
    let claimed_at = std::mem::offset_of!(State, claimed);
    for i in 0..STATE_LEN {
        if (1216..1232).contains(&i) || (claimed_at..claimed_at + 8).contains(&i) {
            continue;
        }
        assert_eq!(raw[i], raw0[i], "State byte {i} changed");
    }
    // ---- the open call: only its budget field (what is left to spend) ----
    let sg = env.signal_bytes();
    for i in (0..sg.len()).filter(|i| sg0[*i] != sg[*i]) {
        assert!((sig::BUDGET..sig::BUDGET + 8).contains(&i), "open call byte {i} changed");
    }
    assert_eq!(rd_u64(&sg, sig::BUDGET), 0, "nothing left to spend");
    assert_eq!((env.data(&env.tape), env.data(&env.diary), env.data(&env.model), env.data(&env.book)), (tape0, diary0, model0, book0), "tape, diary, model and brain book untouched");
    // ---- the memo line ----
    let want = text(withdraw_line(ev.amount, b"HUNCH").as_bytes());
    let m = memos(&r.logs);
    println!("memo: {m:?}");
    assert_eq!(m, vec![want]);
    // ---- what Hunch invoked: the claim, the transfer, the memo, the event; nothing else ----
    let cpis = scan(&env, &ixs, &auth, &r);
    println!("Hunch invoked: {cpis:?}");
    let allowed: BTreeSet<String> =
        ["DBC claim_creator_trading_fee2", "Token sync_native", "Token transfer", "Memo", "Hunch event 6"].iter().map(|s| s.to_string()).collect();
    assert_eq!(cpis, allowed);
    assert!(cu <= 100_000, "{cu} CU");

    // ---- again at once: nothing left, even after the claim ----
    assert_eq!(code(env.withdraw(0)), Some(err::NOTHING_TO_WITHDRAW));
    // ---- the next tick reads the new state as usual: no outside volume came from the withdrawal ----
    let cum = env.state().cum;
    ok(env.tick_at(H0 + 7200 + 1200 + 1), "tick after the withdrawal");
    let tape = env.last_tape();
    assert_eq!(rd_u64(&tape, 24), cum, "the withdrawal is not volume");
    assert_eq!(rd_u64(&tape, 40), 0, "nor Hunch's own trade");
}

#[test]
fn only_the_upgrade_authority_and_never_by_cpi_and_every_refusal_changes_nothing() {
    let (mut env, t) = running(12, SOL);
    env.donate(SOL);
    at(&mut env, H0 + 7200 + 900);
    let auth = env.authority.pubkey();
    let payer = env.payer.pubkey();
    let ak = env.authority.insecure_clone();
    // the developer's WSOL account, made beforehand so each refusal below fails on its own check
    ok(env.send(&[create_ata_ix(&auth, &auth, &wsol_mint())], &[&ak]), "the developer's WSOL account");
    let dest = env.dev_wsol();
    let mut watched = env.watched();
    watched.push(dest);
    let before = env.twin(None);
    let same = |env: &Env| assert!(env.differences(&before, &watched).iter().all(|k| *k == env.authority.pubkey() || *k == env.payer.pubkey()), "a refusal changed an account");
    let send = |env: &mut Env, ix: solana_instruction::Instruction, signers: &[&Keypair]| env.send(&[cu_limit(400_000), ix], signers);

    // anyone else, signing in the authority's place: refused (the payer, a stranger with its own WSOL account)
    let pk = env.payer.insecure_clone();
    let ix = env.withdraw_ix(&payer, &ata_of(&payer, &wsol_mint()), 0);
    ok(env.send_payer(&[create_ata_ix(&payer, &payer, &wsol_mint())]), "the payer's WSOL account");
    assert_eq!(code(send(&mut env, ix, &[&pk])), Some(err::NOT_AUTHORITY));
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), SOL).unwrap();
    ok(env.send(&[create_ata_ix(&stranger.pubkey(), &stranger.pubkey(), &wsol_mint())], &[&stranger]), "a stranger's WSOL account");
    let ix = env.withdraw_ix(&stranger.pubkey(), &ata_of(&stranger.pubkey(), &wsol_mint()), 0);
    assert_eq!(code(send(&mut env, ix, &[&stranger])), Some(err::NOT_AUTHORITY));
    // the authority's address without its signature
    let mut ix = env.withdraw_ix(&auth, &dest, 0);
    ix.accounts[0].is_signer = false;
    assert_eq!(code(send(&mut env, ix, &[&pk])), Some(err::NOT_AUTHORITY));
    // another account in the programdata's place (a copy naming the signer, owned by someone else), or a wrong bump
    let fake = Address::new_unique();
    let mut acc = env.svm.get_account(&env.programdata).unwrap();
    acc.owner = Address::new_unique();
    env.svm.set_account(fake, acc).unwrap();
    let mut ix = env.withdraw_ix(&auth, &dest, 0);
    ix.accounts[1].pubkey = fake;
    assert_eq!(code(send(&mut env, ix, &[&ak])), Some(err::NOT_AUTHORITY));
    let mut ix = env.withdraw_ix(&auth, &dest, 0);
    ix.data[1] = ix.data[1].wrapping_sub(1);
    let e = send(&mut env, ix, &[&ak]).err().map(|e| e.err);
    assert!(
        matches!(e, Some(TransactionError::InstructionError(_, InstructionError::Custom(6)))) || matches!(e, Some(TransactionError::InstructionError(_, InstructionError::InvalidSeeds))),
        "a wrong bump is refused: {e:?}"
    );
    // by CPI (the probe program calling it, the authority's signature passed along)
    let ix = env.via_probe(&env.withdraw_ix(&auth, &dest, 0));
    assert_eq!(code(send(&mut env, ix, &[&ak])), Some(err::CALLED_BY_CPI));
    // the destination: someone else's WSOL account, a coin account of the signer's, the budget's own
    ok(env.send(&[create_ata_ix(&auth, &auth, &env.pool().mint)], &[&ak]), "the developer's coin account");
    for (other, what) in [(ata_of(&t.pubkey(), &wsol_mint()), "a trader's WSOL account"), (ata_of(&auth, &env.pool().mint), "the signer's coin account"), (env.budget_wsol, "the budget's own WSOL account")] {
        let ix = env.withdraw_ix(&auth, &other, 0);
        assert_eq!(code(send(&mut env, ix, &[&ak])), Some(err::WRONG_ACCOUNT), "{what}");
    }
    // more than the budget holds after the claim
    // (what the budget holds after sync_native and the claim: its WSOL account's lamports less rent, plus the creator fee)
    let held = lamports(&env, &env.budget_wsol) - env.svm.minimum_balance_for_rent_exemption(165) + pool_u64(&env, pool::CREATOR_QUOTE_FEE);
    let ix = env.withdraw_ix(&auth, &dest, held + 1);
    assert_eq!(code(send(&mut env, ix, &[&ak])), Some(err::AMOUNT_TOO_HIGH));
    let ix = env.withdraw_ix(&auth, &dest, u64::MAX);
    assert_eq!(code(send(&mut env, ix, &[&ak])), Some(err::AMOUNT_TOO_HIGH));
    // data of another length
    for extra in [vec![0u8], vec![]] {
        let mut ix = env.withdraw_ix(&auth, &dest, 0);
        if extra.is_empty() {
            ix.data.pop();
        } else {
            ix.data.extend(extra);
        }
        let r = send(&mut env, ix, &[&ak]);
        assert!(matches!(r.as_ref().err().map(|e| &e.err), Some(TransactionError::InstructionError(_, InstructionError::InvalidInstructionData))));
    }
    // a foreign account in the budget's WSOL place, another pool, another config; memo and event swapped
    let mut ix = env.withdraw_ix(&auth, &dest, 0);
    ix.accounts[5].pubkey = ata_of(&t.pubkey(), &wsol_mint());
    assert_eq!(code(send(&mut env, ix, &[&ak])), Some(err::WRONG_ACCOUNT));
    let mut ix = env.withdraw_ix(&auth, &dest, 0);
    ix.accounts[15].pubkey = Address::new_unique();
    assert_eq!(code(send(&mut env, ix, &[&ak])), Some(err::WRONG_ACCOUNT));
    let mut ix = env.withdraw_ix(&auth, &dest, 0);
    ix.accounts[16].pubkey = Address::new_unique();
    assert_eq!(code(send(&mut env, ix, &[&ak])), Some(err::WRONG_ACCOUNT));
    let mut ix = env.withdraw_ix(&auth, &dest, 0);
    ix.accounts.swap(12, 13);
    assert_eq!(code(send(&mut env, ix, &[&ak])), Some(err::WRONG_ACCOUNT));
    same(&env);
    // before adoption: the wrong phase
    {
        let mut e = env.twin(None);
        e.set_state(|s| s.phase = phase::SETUP);
        let ix = e.withdraw_ix(&auth, &dest, 0);
        assert_eq!(code(e.send(&[cu_limit(400_000), ix], &[&ak])), Some(err::WRONG_PHASE));
    }

    // ---- part of it, beside other instructions (a memo before it), then the rest ----
    let wsol = lamports(&env, &env.budget_wsol) - env.svm.minimum_balance_for_rent_exemption(165);
    let fee = pool_u64(&env, pool::CREATOR_QUOTE_FEE);
    let dev0 = lamports(&env, &auth);
    let ixs = vec![cu_limit(400_000), memo_ix("before"), env.withdraw_ix(&auth, &dest, SOL / 2)];
    let r = ok(env.send(&ixs, &[&ak]), "half a SOL, beside a memo");
    let ev = env.withdraw_event_of(&r, &ixs, &auth).unwrap();
    assert_eq!((ev.amount, ev.held, ev.left, ev.claimed), (SOL / 2, wsol + fee, wsol + fee - SOL / 2, fee));
    assert_eq!(env.token_amount(&dest), SOL / 2, "the developer's WSOL account holds what was withdrawn");
    assert_eq!(rd_u64(&env.signal_bytes(), sig::BUDGET), ev.left, "the open call's budget: what is left");
    assert_eq!(lamports(&env, &auth), dev0 - SIG_FEE);
    let r = ok(env.withdraw(0), "the rest");
    let ev2 = env.withdraw_event(&r).unwrap();
    assert_eq!((ev2.amount, ev2.claimed, ev2.total, ev2.count), (ev.left, 0, wsol + fee, 2));
    let st = env.state();
    assert_eq!((st.withdrawn, st.withdrawals), (wsol + fee, 2));
    assert_eq!(lamports(&env, &auth), dev0 - 2 * SIG_FEE + wsol + fee + env.svm.minimum_balance_for_rent_exemption(165), "both amounts, and the WSOL account's rent back, less two network fees");
    println!("withdrawn in two parts: {:.6} SOL; memos {:?}", st.withdrawn as f64 / 1e9, memos(&r.logs));

    // ---- a world with nothing in the budget at all ----
    let mut e = Env::new(H0 - 500);
    e.launch("good", H0 - 400, H0 - 300);
    e.tick_at(H0 + 1).unwrap();
    assert_eq!(code(e.withdraw(0)), Some(err::NOTHING_TO_WITHDRAW));
    assert_eq!(code(e.withdraw(1)), Some(err::NOTHING_TO_WITHDRAW));
}

/// The hourly buy around a withdrawal: in the same hour and the next ones it does byte for byte what the
/// deployed build does from the same accounts, spending the fees that arrived after the withdrawal.
#[test]
fn the_hourly_buy_goes_on_after_a_withdrawal_as_the_deployed_build_does() {
    let old = old_so();
    let (mut a, t) = running(17, SOL); // bars 1..17; hour 2's boundary at bar 12
    a.donate(3 * SOL);
    let watched = {
        let mut w = a.watched();
        w.extend([ata_of(&t.pubkey(), &wsol_mint()), ata_of(&t.pubkey(), &a.pool().mint), t.pubkey()]);
        w
    };
    // the deployed build has no tag 12
    let mut probe = a.twin(Some(&old));
    assert!(
        matches!(probe.withdraw(0).err().map(|e| e.err), Some(TransactionError::InstructionError(_, InstructionError::InvalidInstructionData))),
        "a twin runs the deployed build, which has no withdrawal"
    );

    // ---- hour 2: the withdrawal first, then trades, then the hourly buy on the new fees ----
    at(&mut a, H0 + 10_250);
    let r = ok(a.withdraw(0), "withdraw, hour 2");
    let w1 = a.withdraw_event(&r).unwrap();
    at(&mut a, H0 + 10_300);
    a.churn(&t, 3 * SOL);
    let fresh = pool_u64(&a, pool::CREATOR_QUOTE_FEE);
    let mut b = a.twin(Some(&old));
    let ra = ok(hourly(&mut a, H0 + 10_400), "hourly buy after the withdrawal (new build)");
    let rb = ok(hourly(&mut b, H0 + 10_400), "hourly buy after the withdrawal (deployed build)");
    assert_eq!(a.differences(&b, &watched), Vec::<Address>::new(), "the hourly buy after a withdrawal differs from the deployed build");
    assert_eq!(memos(&ra.logs), memos(&rb.logs));
    let st = a.state();
    println!(
        "hour 2: withdrew {:.6} SOL; then {:.6} SOL of new creator fee; the hourly buy {} {:.6} SOL of {:.6} held, as the deployed build does",
        w1.amount as f64 / 1e9,
        fresh as f64 / 1e9,
        if st.hs_reason == 0 { "bought" } else { "waited" },
        st.hs_bought as f64 / 1e9,
        st.hs_held as f64 / 1e9
    );
    assert_eq!((st.hs_reason, st.hs_held), (0, fresh), "it bought, from the new fee only");
    assert!(st.hs_bought > 0);

    // ---- hour 3: ticks with trades and the hourly buy, the new build against the deployed one ----
    let mut b = a.twin(Some(&old));
    for b_ in 18..=21 {
        bar(&mut a, &t, b_, SOL);
        bar(&mut b, &t, b_, SOL);
        assert_eq!(a.differences(&b, &watched), Vec::<Address>::new(), "tick bar {b_} differs from the deployed build");
    }
    let ra = hourly(&mut a, H0 + 10_800 + 2_000);
    let rb = hourly(&mut b, H0 + 10_800 + 2_000);
    assert_eq!(ra.is_ok(), rb.is_ok());
    assert_eq!(a.differences(&b, &watched), Vec::<Address>::new(), "hour 3's hourly buy differs from the deployed build");
    let st = a.state();
    println!("hour 3: the hourly buy {} {:.6} SOL, as the deployed build does", if st.hs_reason == 0 { "bought" } else { "waited" }, st.hs_bought as f64 / 1e9);
    assert_eq!(st.last_buy_hour, ((H0 + 10_800 + 2_000) / 3600) as u32, "hour 3 bought");

    // ---- hour 3, after its buy: a second withdrawal; the hourly buy is still refused as before ----
    a.donate(SOL);
    at(&mut a, H0 + 10_800 + 2_100);
    let r = ok(a.withdraw(0), "withdraw, hour 3");
    let w2 = a.withdraw_event(&r).unwrap();
    assert_eq!(code(hourly(&mut a, H0 + 10_800 + 2_200)), Some(err::ALREADY_BOUGHT_THIS_HOUR));

    // ---- hour 4: ticks with trades, the hourly buy, from the accounts the withdrawal left ----
    let mut b = a.twin(Some(&old));
    for b_ in 22..=25 {
        bar(&mut a, &t, b_, SOL);
        bar(&mut b, &t, b_, SOL);
        assert_eq!(a.differences(&b, &watched), Vec::<Address>::new(), "tick bar {b_} differs from the deployed build");
    }
    let ra = hourly(&mut a, H0 + 14_400 + 1_000);
    let rb = hourly(&mut b, H0 + 14_400 + 1_000);
    assert_eq!(ra.is_ok(), rb.is_ok());
    assert_eq!(a.differences(&b, &watched), Vec::<Address>::new(), "hour 4's hourly buy differs from the deployed build");
    let st = a.state();
    println!(
        "hour 4: after a second withdrawal of {:.6} SOL, the hourly buy {} {:.6} SOL; withdrawn in all {:.6} SOL in {} withdrawals",
        w2.amount as f64 / 1e9,
        if st.hs_reason == 0 { "bought" } else { "waited" },
        st.hs_bought as f64 / 1e9,
        st.withdrawn as f64 / 1e9,
        st.withdrawals
    );
    assert_eq!(st.last_buy_hour, ((H0 + 14_400 + 1_000) / 3600) as u32, "hour 4 bought");
    assert_eq!((st.withdrawn, st.withdrawals), (w1.amount + w2.amount, 2));
}
