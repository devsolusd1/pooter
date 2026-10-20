//! Graduation against Meteora's real bytecode: DBC (the pool, its completion, creator_withdraw_surplus,
//! the migration, withdraw_leftover) and DAMM v2 and SPL Token-2022 as deployed on mainnet, with the DAMM
//! v2 config DBC's Customizable migration uses cloned from mainnet. Hunch is the pool's creator (the
//! budget PDA), so the real migration hands it the creator's 33% position NFT. Then adopt_pool (the
//! migrated pool and Hunch's position, and the outside pools and positions it must refuse), ticks on the
//! DAMM v2 pool with real trades, claim_pool_fees and buy_and_burn_pool by CPI, liquidity added just before
//! a buy, and Meteora changing the fee and pausing the pool.

use {
    hunch::{
        ids::{err, event},
        layout::{self, *},
        rules::{self, df, phase, sf, DammFee},
    },
    hunch_tests::*,
    litesvm::types::FailedTransactionMetadata,
    solana_address::Address,
    solana_keypair::Keypair,
    solana_signer::Signer,
    std::collections::BTreeSet,
};

const H0: i64 = 1_790_002_800; // a UTC hour start
const SOL: u64 = 1_000_000_000;
const BAR: i64 = 600;

fn code<T>(r: Result<T, FailedTransactionMetadata>) -> Option<u32> {
    r.err().and_then(|e| custom_code(&e))
}
fn ok(r: Result<TransactionMetadata, FailedTransactionMetadata>, what: &str) -> TransactionMetadata {
    r.unwrap_or_else(|e| panic!("{what}: {:?}\n{}", e.err, e.meta.logs.join("\n")))
}

/// Every instruction Hunch invoked directly (stack height 2) in a transaction made of `ixs`, by program and kind.
fn scan(env: &Env, ixs: &[solana_instruction::Instruction], meta: &TransactionMetadata, seen: &mut BTreeSet<String>) {
    let keys = env.message_keys(ixs, &env.payer.pubkey());
    for ii in meta.inner_instructions.iter().flatten().filter(|ii| ii.stack_height == 2) {
        let pid = keys[ii.instruction.program_id_index as usize];
        let d = &ii.instruction.data;
        let kind = if pid == dbc() && d[..8] == hunch::ids::CREATOR_WITHDRAW_SURPLUS {
            "DBC creator_withdraw_surplus".to_string()
        } else if pid == damm() && d[..8] == hunch::ids::DAMM_CLAIM_POSITION_FEE {
            "DAMM v2 claim_position_fee".to_string()
        } else if pid == damm() && d[..8] == hunch::ids::DAMM_SWAP2 {
            format!("DAMM v2 swap2 mode {}", d[24])
        } else if pid == token_program() && (d[0] == 17 || d[0] == 8) {
            if d[0] == 17 { "Token sync_native".into() } else { "Token burn".into() }
        } else if pid == memo_program() {
            "Memo".into()
        } else if pid == env.hunch {
            format!("Hunch event {}", d[1])
        } else {
            format!("OTHER {pid} {:?}", &d[..d.len().min(8)])
        };
        seen.insert(kind);
    }
}
/// What Hunch may invoke on the graduation path: nothing else moves value.
const ALLOWED: [&str; 11] = [
    "DBC creator_withdraw_surplus",
    "DAMM v2 claim_position_fee",
    "DAMM v2 swap2 mode 0",
    "Token sync_native",
    "Token burn",
    "Memo",
    "Hunch event 1",
    "Hunch event 2",
    "Hunch event 3",
    "Hunch event 4",
    "Hunch event 5",
];

fn tick_bar(env: &mut Env, b: i64) -> TransactionMetadata {
    let r = env.tick_at(H0 + b * BAR + 1);
    ok(r, &format!("tick bar {b}"))
}

struct Graduated {
    env: Env,
    trader: Keypair,
    partner: DammKeys,
    creator: DammKeys,
    surplus: u64,
    leftover: u64,
    migrate_cu: u64,
    surplus_cu: u64,
    /// what DBC's own completion left as surplus (a few lamports of rounding)
    surplus_left: u64,
    /// the instructions Hunch invoked in withdraw_surplus and adopt_pool
    cpis: BTreeSet<String>,
}

/// The "grad" curve (completes at a few SOL, 20M HUNCH of leftover for the budget), Hunch adopted on it,
/// 2 hours of ticks and trades, a trader completes the curve, the next boundary turns Hunch to
/// graduating; withdraw_surplus; the real migration; withdraw_leftover. The clock ends at bar 19.
fn graduated() -> Graduated {
    let mut env = Env::new(H0 - 500);
    env.load_damm();
    env.launch("grad", H0 - 400, H0 - 300);
    let t = env.trader(5_000 * SOL);
    env.tick_at(H0 + 1).unwrap();
    for b in 1..=12 {
        env.set_clock(H0 + b * BAR - 300, 0);
        env.churn(&t, SOL / 10);
        tick_bar(&mut env, b);
    }
    let threshold = rd_u64(&env.data(&env.pool().config), config::MIGRATION_QUOTE_THRESHOLD);
    // withdraw_surplus before the curve completes: DBC refuses it
    env.set_clock(H0 + 7200 + 20, 0);
    assert!(env.send_payer(&[cu_limit(200_000), env.withdraw_surplus_ix()]).is_err(), "surplus before completion");
    // a trader buys the curve out (the last buy a partial fill at the migration price)
    let mut n = 0;
    while rd_u64(&env.data(&env.pool().pool), pool::QUOTE_RESERVE) < threshold && n < 60 {
        let _ = env.trade_partial(&t, SOL);
        n += 1;
    }
    let reserve = rd_u64(&env.data(&env.pool().pool), pool::QUOTE_RESERVE);
    println!("grad curve: completes at {:.4} SOL; quote reserve {:.4} SOL after {n} buys", threshold as f64 / 1e9, reserve as f64 / 1e9);
    assert!(reserve >= threshold);
    for b in 13..=18 {
        tick_bar(&mut env, b);
    }
    assert_eq!(env.state().phase, phase::GRADUATING);
    // The SDK's curve ends exactly at its threshold (the last buy is a partial fill), so DBC owes no
    // surplus. A curve whose last buy overshoots leaves one: write 1 SOL of it into the pool and its quote
    // vault (as DBC would hold it) so the PDA-signed creator_withdraw_surplus moves real lamports.
    let natural = rd_u64(&env.data(&env.pool().pool), pool::QUOTE_RESERVE) - threshold;
    println!("surplus DBC's own completion leaves: {natural} lamports; 1 SOL written into the pool for the test");
    {
        let p = env.pool().pool;
        let qv = env.pool().quote_vault;
        let mut a = env.svm.get_account(&p).unwrap();
        let r = rd_u64(&a.data, pool::QUOTE_RESERVE);
        wr_u64(&mut a.data, pool::QUOTE_RESERVE, r + SOL);
        env.svm.set_account(p, a).unwrap();
        let mut v = env.svm.get_account(&qv).unwrap();
        let amt = rd_u64(&v.data, 64);
        wr_u64(&mut v.data, 64, amt + SOL);
        v.lamports += SOL;
        env.svm.set_account(qv, v).unwrap();
    }
    // withdraw_surplus: once, into the budget's WSOL account
    env.set_clock(H0 + 18 * BAR + 120, 0);
    let before = env.token_amount(&env.budget_wsol);
    let ixs = vec![cu_limit(200_000), env.withdraw_surplus_ix()];
    let r = ok(env.send_payer(&ixs), "withdraw_surplus");
    let mut cpis = BTreeSet::new();
    scan(&env, &ixs, &r, &mut cpis);
    let surplus_cu = hunch_cu(&r.logs).unwrap_or(0);
    let surplus = env.token_amount(&env.budget_wsol) - before;
    assert_eq!(env.state().surplus, surplus);
    assert!(env.send_payer(&[cu_limit(200_000), env.withdraw_surplus_ix()]).is_err(), "a second withdraw_surplus");
    // adopt_pool before the migration: refused
    let early = DammKeys {
        pool: damm_pool_address(&damm_config_customizable(), &env.pool().mint, &wsol_mint()),
        config: damm_config_customizable(),
        vault_a: Address::default(),
        vault_b: Address::default(),
        position: Address::default(),
        nft: Address::default(),
        nft_mint: Address::default(),
    };
    assert_eq!(code(env.send_payer(&[env.adopt_pool_ix(&early)])), Some(err::NOT_MIGRATED));
    // the real migration (anyone may send it; Meteora's keepers usually do)
    let (partner, creator, r) = env.migrate();
    let r = ok(r, "migration_damm_v2");
    let migrate_cu = r.compute_units_consumed;
    // DBC's leftover, permissionless, to the leftover receiver: the budget's HUNCH account
    let lb = env.token_amount(&env.budget_hunch());
    ok(env.send_payer(&[cu_limit(200_000), env.withdraw_leftover_ix()]), "withdraw_leftover");
    let leftover = env.token_amount(&env.budget_hunch()) - lb;
    Graduated { env, trader: t, partner, creator, surplus, leftover, migrate_cu, surplus_cu, surplus_left: natural, cpis }
}

#[test]
fn real_migration_then_adopt_pool_takes_only_the_migrated_pool_and_hunch_s_position() {
    let g = graduated();
    let Graduated { mut env, trader: t, partner, creator, surplus, leftover, migrate_cu, surplus_cu, surplus_left, .. } = g;
    println!("withdraw_surplus: {:.6} SOL into the budget ({surplus_cu} CU); migration {migrate_cu} CU; leftover {} HUNCH to the budget", surplus as f64 / 1e9, leftover / 1_000_000);
    assert!(leftover > 0, "the grad curve leaves HUNCH for the budget");
    let natural = surplus_left;
    assert_eq!(surplus, (SOL + natural) * 80 / 100 * 33 / 100, "the creator's share of the surplus: 80% to partner and creator, 33% of that");

    // the migrated pool, read at the offsets Hunch uses (cp-amm source), checked against what DBC asked for
    let d = env.data(&creator.pool);
    assert_eq!(d.len(), damm::LEN);
    assert_eq!(&d[..8], &hunch::ids::DAMM_POOL_DISC);
    assert_eq!(&d[damm::TOKEN_A_MINT..damm::TOKEN_A_MINT + 32], env.pool().mint.as_ref());
    assert_eq!(&d[damm::TOKEN_B_MINT..damm::TOKEN_B_MINT + 32], wsol_mint().as_ref());
    assert_eq!(&d[damm::TOKEN_A_VAULT..damm::TOKEN_A_VAULT + 32], creator.vault_a.as_ref());
    assert_eq!(&d[damm::TOKEN_B_VAULT..damm::TOKEN_B_VAULT + 32], creator.vault_b.as_ref());
    assert_eq!(&d[damm::CREATOR..damm::CREATOR + 32], dbc_pool_authority().as_ref());
    assert_eq!(d[damm::COLLECT_FEE_MODE], damm::ONLY_B);
    assert_eq!(rd_u128(&d, damm::SQRT_MAX_PRICE), MAX_SQRT_PRICE);
    assert_eq!(rd_u128(&d, damm::SQRT_MIN_PRICE), MIN_SQRT_PRICE);
    let fee: DammFee = damm_fee_of(&d);
    println!(
        "DAMM v2 pool {}: fee {} bps (mode {}, periods {}, dynamic {}, version {}), protocol {}%, liquidity {}, sqrt_price {}, permanent lock {}, SOL side {:.4}",
        creator.pool,
        fee.numerator() / 100_000,
        fee.mode,
        fee.n_periods,
        fee.dynamic,
        fee.fee_version,
        d[damm::FEE_SPLIT],
        rd_u128(&d, damm::LIQUIDITY),
        rd_u128(&d, damm::SQRT_PRICE),
        rd_u128(&d, damm::PERMANENT_LOCK_LIQUIDITY),
        rd_u64(&d, damm::TOKEN_B_AMOUNT) as f64 / 1e9
    );
    assert_eq!(fee.numerator(), 37_500_000, "the migrated pool charges 3.75%");
    assert!(fee.plain());
    // the two positions: the partner's 67% to the fee claimer, the creator's 33% to the budget PDA
    for (k, owner, name) in [(&partner, env.payer.pubkey(), "partner"), (&creator, env.budget, "creator")] {
        let p = env.data(&k.position);
        let nft = env.data(&k.nft);
        let locked = rd_u128(&p, position::PERMANENT_LOCKED_LIQUIDITY);
        println!(
            "{name} position {}: locked {} ({:.2}% of the pool), unlocked {}, NFT account {} bytes owned by {}",
            k.position,
            locked,
            100.0 * locked as f64 / rd_u128(&d, damm::LIQUIDITY) as f64,
            rd_u128(&p, position::UNLOCKED_LIQUIDITY),
            nft.len(),
            Address::new_from_array(nft[32..64].try_into().unwrap())
        );
        assert_eq!(p.len(), position::LEN);
        assert_eq!(&p[position::POOL..position::POOL + 32], creator.pool.as_ref());
        assert_eq!(&p[position::NFT_MINT..position::NFT_MINT + 32], k.nft_mint.as_ref());
        assert_eq!(&nft[32..64], owner.as_ref());
        assert_eq!(rd_u64(&nft, 64), 1);
        assert_eq!(env.svm.get_account(&k.nft).unwrap().owner, token_2022());
    }
    let dbc = env.data(&env.pool().pool);
    assert_eq!((dbc[pool::IS_MIGRATED], dbc[pool::MIGRATION_PROGRESS]), (1, pool::MIGRATION_CREATED_POOL));

    // ---- what adopt_pool refuses ----
    env.set_clock(H0 + 18 * BAR + 300, 0);
    // (1) an outside HUNCH/SOL pool on DAMM v2 (initialize_customizable_pool, permissionless), at the same
    //     price, with the outsider's position NFT handed to... the outsider (and the real config passed)
    let sp = rd_u128(&d, damm::SQRT_PRICE);
    let (outside, r) = env.outside_pool(&t, sp, 1u128 << 70);
    ok(r, "initialize_customizable_pool (an outside pool)");
    println!("outside pool {} (customizable, made by a trader): {} bytes", outside.pool, env.data(&outside.pool).len());
    let mut cases: Vec<(&str, DammKeys, u32)> = vec![("an outside HUNCH/SOL pool with the real config", outside.clone(), err::OUTSIDE_POOL)];
    // (2) the outside pool with its own address but a config whose pool creator is not DBC's authority
    let fake_config = Keypair::new().pubkey();
    let mut cfg = env.svm.get_account(&damm_config_customizable()).unwrap();
    cfg.data[damm_config::POOL_CREATOR_AUTHORITY..damm_config::POOL_CREATOR_AUTHORITY + 32].copy_from_slice(t.pubkey().as_ref());
    env.svm.set_account(fake_config, cfg).unwrap();
    cases.push(("the migrated pool with a config whose creator is not DBC's", DammKeys { config: fake_config, ..creator.clone() }, err::OUTSIDE_POOL));
    // (3) the migrated pool, but the partner's position (its NFT belongs to the fee claimer)
    cases.push(("the partner's position", DammKeys { position: partner.position, nft: partner.nft, nft_mint: partner.nft_mint, ..creator.clone() }, err::NOT_OUR_POSITION));
    // (4) a position the budget owns but that holds nothing (create_position is permissionless)
    let (empty_pos, empty_nft, empty_mint, r) = {
        env.damm = Some(creator.clone());
        let budget = env.budget;
        let x = env.create_position(&budget);
        env.damm = None;
        x
    };
    ok(r, "create_position for the budget");
    cases.push(("an empty position whose NFT the budget holds", DammKeys { position: empty_pos, nft: empty_nft, nft_mint: empty_mint, ..creator.clone() }, err::NOT_OUR_POSITION));
    // (5) the real position with another position's NFT account
    cases.push(("Hunch's position with the partner's NFT account", DammKeys { nft: partner.nft, ..creator.clone() }, err::NOT_OUR_POSITION));
    // (6) the outside pool's own position (its NFT is the trader's)
    cases.push(("the outside pool's position in the migrated pool's slot", DammKeys { position: outside.position, nft: outside.nft, ..creator.clone() }, err::NOT_OUR_POSITION));
    for (what, k, want) in cases {
        let r = env.send_payer(&[cu_limit(400_000), env.adopt_pool_ix(&k)]);
        assert_eq!(code(r), Some(want), "{what}");
        println!("adopt_pool refuses {what}: error {want}");
    }
    // an outside pool's own address can never be adopted: it is not the PDA of a DBC-only config
    assert_ne!(outside.pool, creator.pool);

    // an outsider doubles the pool's liquidity just before adoption (withdrawable, not locked): Hunch's
    // position falls to 16.5% of the pool's liquidity but keeps 33% of what is locked for good, so this
    // cannot block the adoption
    env.damm = Some(creator.clone());
    let tp = t.pubkey();
    let (pos, nft, _, r) = env.create_position(&tp);
    ok(r, "create_position (outsider)");
    let l = rd_u128(&env.data(&creator.pool), damm::LIQUIDITY);
    let ix = env.add_liquidity_ix(&tp, &pos, &nft, l);
    ok(env.send(&[cu_limit(400_000), ix], &[&t]), "add_liquidity (outsider)");
    env.damm = None;
    let d2 = env.data(&creator.pool);
    println!(
        "an outsider added liquidity: pool liquidity {} (was {l}), locked for good {}",
        rd_u128(&d2, damm::LIQUIDITY),
        rd_u128(&d2, damm::PERMANENT_LOCK_LIQUIDITY)
    );
    assert!(rd_u128(&d2, damm::LIQUIDITY) >= 2 * l - 1);

    // ---- the migrated pool and Hunch's position: adopted ----
    let st0 = env.state();
    let r = ok(env.adopt_pool(creator.clone()), "adopt_pool");
    let cu = hunch_cu(&r.logs).unwrap();
    let st = env.state();
    println!("adopt_pool: {cu} CU; curve record kept {}/{} (forfeits {}), pool record starts at {}", st.prev_hits, st.prev_n, st.prev_forfeits, st.n);
    assert_eq!(st.phase, phase::POOL);
    assert_eq!((st.prev_n, st.prev_hits, st.prev_rule_hits), (st0.n, st0.hits, st0.rule_hits));
    assert_eq!((st.n, st.hits, st.forfeits, st.not_scored), (0, 0, 0, 0));
    assert_eq!(st.adopt_fee_num, 37_500_000);
    assert_eq!(st.damm_pool, creator.pool.to_bytes());
    assert_eq!(st.position, creator.position.to_bytes());
    let sig = env.signal_bytes();
    assert_eq!(sig[layout::sig::PHASE], phase::POOL);
    assert_eq!(rd_u32(&sig, layout::sig::PREV_N), st0.n);
    assert_eq!(rd_u16(&sig, layout::sig::POOL_FEE_BPS), 375);
    // once
    assert_eq!(code(env.send_payer(&[cu_limit(400_000), env.adopt_pool_ix(&creator)])), Some(err::WRONG_PHASE));
    // the DBC buy is closed for good, and the DBC pool is no longer the one a tick reads
    assert_eq!(code(env.buy()), Some(err::WRONG_PHASE));
}

/// The DBC config's migration threshold and sqrt price, and the liquidity DBC's migration builds from them.
fn migration_bar(env: &Env) -> (u64, u128, u128) {
    let cfg = env.data(&env.pool().config);
    let (threshold, sp) = (rd_u64(&cfg, config::MIGRATION_QUOTE_THRESHOLD), rd_u128(&cfg, config::MIGRATION_SQRT_PRICE));
    (threshold, sp, rules::migration_liquidity(threshold, sp).unwrap())
}

/// An outsider puts liquidity of their own into the migrated pool and locks it there for good before
/// adopt_pool lands: create_position, add_liquidity and permanent_lock_position are permissionless for one's
/// own position (and DBC's migration is permissionless too, so all of it can ride in one bundle). The pool's
/// permanent lock grows and Hunch's position falls under a quarter of it, but adopt_pool measures the
/// position against the liquidity the migration builds from the pinned threshold and price, so it still
/// adopts Hunch's real position, and the pool phase runs (a claim and a buy).
#[test]
fn an_outside_permanent_lock_before_adoption_cannot_block_it() {
    let Graduated { mut env, trader: t, creator, .. } = graduated();
    let (threshold, sp_mig, l_mig) = migration_bar(&env);
    let d = env.data(&creator.pool);
    let (l, locked0, sol_side) = (rd_u128(&d, damm::LIQUIDITY), rd_u128(&d, damm::PERMANENT_LOCK_LIQUIDITY), rd_u64(&d, damm::TOKEN_B_AMOUNT));
    let ours = rd_u128(&env.data(&creator.position), position::PERMANENT_LOCKED_LIQUIDITY);
    println!(
        "migrated pool: sqrt_price {} (the config's migration price {sp_mig}), SOL side {:.4} of a {:.4} SOL threshold; liquidity {l}, locked {locked0}; the migration's liquidity from the pinned values {l_mig}; Hunch's position {:.3}% of it",
        rd_u128(&d, damm::SQRT_PRICE),
        sol_side as f64 / 1e9,
        threshold as f64 / 1e9,
        100.0 * ours as f64 / l_mig as f64
    );
    assert_eq!(rd_u128(&d, damm::SQRT_PRICE), sp_mig, "DBC's migration opens the pool at the config's migration price");
    assert!(l <= l_mig && l_mig - l <= l_mig / 100, "the pool holds the migration's liquidity, within 1%");
    assert!(ours * 100 >= l_mig * 32 && ours * 100 <= l_mig * 33, "Hunch's position is 32-33% of the migration's liquidity");

    // the outsider: 34% of the pool's liquidity added to a position of their own, and locked for good
    env.set_clock(H0 + 18 * BAR + 200, 0);
    env.damm = Some(creator.clone());
    let tp = t.pubkey();
    let w0 = env.token_amount(&ata_of(&tp, &wsol_mint()));
    let (pos, nft, _, r) = env.create_position(&tp);
    ok(r, "create_position (outsider)");
    let add = l * 34 / 100;
    let ixs = [cu_limit(400_000), env.add_liquidity_ix(&tp, &pos, &nft, add), env.permanent_lock_ix(&tp, &pos, &nft, add)];
    ok(env.send(&ixs, &[&t]), "add_liquidity + permanent_lock_position (outsider)");
    env.damm = None;
    let locked1 = rd_u128(&env.data(&creator.pool), damm::PERMANENT_LOCK_LIQUIDITY);
    println!(
        "the outsider locked {add} for good ({:.4} SOL of WSOL and the HUNCH beside it): the pool's lock {locked0} -> {locked1}; Hunch's share of it {:.2}%",
        (w0 - env.token_amount(&ata_of(&tp, &wsol_mint()))) as f64 / 1e9,
        100.0 * ours as f64 / locked1 as f64
    );
    assert!(ours * 100 < locked1 * 25, "Hunch's position is under a quarter of the pool's lock (the old bar refused it here)");

    // adopt_pool: Hunch's real position, in POOL
    env.set_clock(H0 + 18 * BAR + 300, 0);
    let r = ok(env.adopt_pool(creator.clone()), "adopt_pool after the outside lock");
    let st = env.state();
    println!("adopt_pool: {} CU; phase {}, position {}", hunch_cu(&r.logs).unwrap_or(0), st.phase, Address::new_from_array(st.position));
    assert_eq!(st.phase, phase::POOL);
    assert_eq!((st.position, st.position_nft), (creator.position.to_bytes(), creator.nft.to_bytes()));
    assert_eq!((st.migration_quote_threshold, u128_of(st.migration_sqrt_price)), (threshold, sp_mig), "adopt_curve pinned the config's threshold and migration price");
    // the pool phase runs: the position's fees are claimed and the hourly buy lands
    for b in 19..=36 {
        pool_bar(&mut env, &t, b, SOL / 2);
    }
    env.set_clock(H0 + 36 * BAR + 30, 0);
    let w0 = env.token_amount(&env.budget_wsol);
    ok(env.send_payer(&[cu_limit(400_000), env.claim_pool_ix()]), "claim_pool_fees");
    assert!(env.token_amount(&env.budget_wsol) > w0, "the adopted position's fees were claimed");
    env.set_clock(H0 + 36 * BAR + 60, 0);
    let r = ok(env.buy_pool(), "buy_and_burn_pool");
    assert!(buy_pool_event(&env, &r).is_some(), "a buy");
}

/// A position handed to the budget is adopted only with at least 25% of the migration's liquidity locked
/// for good. A position the budget holds with one unit under that bar, and a dust position (an outsider's
/// own, liquidity added and locked, its NFT then sent to the budget), are refused; Hunch's real position is
/// adopted.
#[test]
fn a_position_under_a_quarter_of_the_migration_liquidity_is_refused() {
    let Graduated { mut env, trader: t, creator, .. } = graduated();
    let (_, _, l_mig) = migration_bar(&env);
    env.set_clock(H0 + 18 * BAR + 200, 0);
    env.damm = Some(creator.clone());
    let tp = t.pubkey();
    let budget = env.budget;
    // a position the budget owns (create_position is permissionless), its lock written one unit under the
    // bar (still above a quarter of the migrated pool's own lock, which DBC fills to 99.8% of the threshold)
    let (own_pos, own_nft, own_mint, r) = env.create_position(&budget);
    ok(r, "create_position for the budget");
    let bar = (l_mig * 25).div_ceil(100);
    let mut a = env.svm.get_account(&own_pos).unwrap();
    wr_u128(&mut a.data, position::PERMANENT_LOCKED_LIQUIDITY, bar - 1);
    env.svm.set_account(own_pos, a).unwrap();
    assert!((bar - 1) * 100 >= rd_u128(&env.data(&creator.pool), damm::PERMANENT_LOCK_LIQUIDITY) * 25);
    let under = DammKeys { position: own_pos, nft: own_nft, nft_mint: own_mint, ..creator.clone() };
    assert_eq!(code(env.send_payer(&[cu_limit(400_000), env.adopt_pool_ix(&under)])), Some(err::NOT_OUR_POSITION), "one unit under the bar");
    println!("adopt_pool refuses a budget position one unit under 25% of the migration's liquidity: error {}", err::NOT_OUR_POSITION);
    // the outsider's dust: 1% of the migration's liquidity, locked for good, the NFT sent to the budget
    let (pos, nft, nft_mint, r) = env.create_position(&tp);
    ok(r, "create_position (outsider)");
    let dust = l_mig / 100;
    let ixs = [cu_limit(400_000), env.add_liquidity_ix(&tp, &pos, &nft, dust), env.permanent_lock_ix(&tp, &pos, &nft, dust)];
    ok(env.send(&ixs, &[&t]), "add_liquidity + permanent_lock_position (dust)");
    let to = ata_2022_of(&budget, &nft_mint);
    let ixs = [create_ata_2022_ix(&tp, &budget, &nft_mint), token_2022_transfer_checked_ix(&nft, &nft_mint, &to, &tp, 1, 0)];
    ok(env.send(&ixs, &[&t]), "the dust position's NFT to the budget");
    env.damm = None;
    let n = env.data(&to);
    assert_eq!((&n[32..64], rd_u64(&n, 64)), (budget.as_ref(), 1), "the budget holds the dust position's NFT");
    assert_eq!(rd_u128(&env.data(&pos), position::PERMANENT_LOCKED_LIQUIDITY), dust);
    env.set_clock(H0 + 18 * BAR + 300, 0);
    let dusty = DammKeys { position: pos, nft: to, nft_mint, ..creator.clone() };
    assert_eq!(code(env.send_payer(&[cu_limit(400_000), env.adopt_pool_ix(&dusty)])), Some(err::NOT_OUR_POSITION), "a dust position");
    println!("adopt_pool refuses a dust position handed to the budget: error {}", err::NOT_OUR_POSITION);
    assert_eq!(env.state().phase, phase::GRADUATING);
    ok(env.adopt_pool(creator.clone()), "adopt_pool (Hunch's position)");
    assert_eq!(env.state().position, creator.position.to_bytes());
}

/// The launch's own config (dbc-ixs.mjs "good": about 96 SOL to complete), bought out by one trader in
/// 1-SOL buys, migrated by DBC's real migration; then an outsider locks 34% of the pool's liquidity for good
/// before adoption (about a third of the SOL side). adopt_pool still takes Hunch's position.
#[test]
fn the_launch_config_adopts_hunch_s_position_after_an_outside_lock() {
    let mut env = Env::new(H0 - 500);
    env.load_damm();
    env.launch("good", H0 - 400, H0 - 300);
    let t = env.trader(5_000 * SOL);
    env.set_clock(H0 - 200, 3_000);
    let (threshold, sp_mig, l_mig) = migration_bar(&env);
    let mut n = 0;
    while rd_u64(&env.data(&env.pool().pool), pool::QUOTE_RESERVE) < threshold && n < 400 {
        let _ = env.trade_partial(&t, SOL);
        n += 1;
    }
    assert!(rd_u64(&env.data(&env.pool().pool), pool::QUOTE_RESERVE) >= threshold, "the curve completed");
    env.set_clock(H0 - 100, 3_100);
    let (_, creator, r) = env.migrate();
    ok(r, "migration_damm_v2");
    let d = env.data(&creator.pool);
    let (l, sol_side) = (rd_u128(&d, damm::LIQUIDITY), rd_u64(&d, damm::TOKEN_B_AMOUNT));
    let ours = rd_u128(&env.data(&creator.position), position::PERMANENT_LOCKED_LIQUIDITY);
    println!(
        "launch config: completes at {:.4} SOL after {n} buys; migrated pool SOL side {sol_side} lamports ({:.3}% of the threshold), sqrt_price {} (config {sp_mig}); liquidity {l}, the migration's liquidity {l_mig}; Hunch's position {:.3}% of it",
        threshold as f64 / 1e9,
        100.0 * sol_side as f64 / threshold as f64,
        rd_u128(&d, damm::SQRT_PRICE),
        100.0 * ours as f64 / l_mig as f64
    );
    assert_eq!(rd_u128(&d, damm::SQRT_PRICE), sp_mig);
    assert!(ours * 100 >= l_mig * 32 && ours * 100 <= l_mig * 33);
    env.damm = Some(creator.clone());
    let tp = t.pubkey();
    let w0 = env.token_amount(&ata_of(&tp, &wsol_mint()));
    let (pos, nft, _, r) = env.create_position(&tp);
    ok(r, "create_position (outsider)");
    let add = l * 34 / 100;
    let ixs = [cu_limit(400_000), env.add_liquidity_ix(&tp, &pos, &nft, add), env.permanent_lock_ix(&tp, &pos, &nft, add)];
    ok(env.send(&ixs, &[&t]), "add_liquidity + permanent_lock_position (outsider)");
    env.damm = None;
    let locked1 = rd_u128(&env.data(&creator.pool), damm::PERMANENT_LOCK_LIQUIDITY);
    println!(
        "the outsider locked {:.4} SOL and the HUNCH beside it for good; Hunch's share of the pool's lock {:.2}%",
        (w0 - env.token_amount(&ata_of(&tp, &wsol_mint()))) as f64 / 1e9,
        100.0 * ours as f64 / locked1 as f64
    );
    assert!(ours * 100 < locked1 * 25);
    ok(env.adopt_pool(creator.clone()), "adopt_pool after the outside lock");
    assert_eq!((env.state().phase, env.state().position), (phase::POOL, creator.position.to_bytes()));
}

// ------------------------------------------------------------------------------------------------
// after adoption
// ------------------------------------------------------------------------------------------------

/// graduated(), then adopt_pool at bar 18 + 300 s (hour 3): the pool's warm-up covers hours 3 and 4.
fn adopted() -> Graduated {
    let mut g = graduated();
    g.env.set_clock(H0 + 18 * BAR + 300, 0);
    let c = g.creator.clone();
    let ixs = vec![cu_limit(400_000), g.env.adopt_pool_ix(&c)];
    let r = ok(g.env.send_payer(&ixs), "adopt_pool");
    g.env.damm = Some(c);
    scan(&g.env, &ixs, &r, &mut g.cpis);
    g
}

/// Bar `b`: a round trip of about `churn` lamports on DAMM v2 mid-way through the previous bar (varied bar by
/// bar, so hours differ), then the tick.
fn pool_bar(env: &mut Env, t: &Keypair, b: i64, churn: u64) -> TransactionMetadata {
    if churn > 0 {
        env.set_clock(H0 + b * BAR - 300, 0);
        let k = ((b as u64).wrapping_mul(2_654_435_761) >> 7) % 9;
        env.churn_pool(t, churn / 2 + churn * k / 8);
    }
    tick_bar(env, b)
}

/// Hunch's events in a transaction made of `ixs`.
fn events_of(env: &Env, ixs: &[solana_instruction::Instruction], r: &TransactionMetadata) -> Vec<(u8, Vec<u8>)> {
    let keys = env.message_keys(ixs, &env.payer.pubkey());
    env.events(r, &keys)
}
fn bar_event(env: &Env, r: &TransactionMetadata) -> Vec<u8> {
    let ixs = vec![cu_limit(400_000), env.tick_ix()];
    events_of(env, &ixs, r).into_iter().find(|(k, _)| *k == event::BAR).map(|(_, d)| d).unwrap()
}
#[allow(clippy::type_complexity)]
fn buy_pool_event(env: &Env, r: &TransactionMetadata) -> Option<(u64, u64, u64, u64, u64, u64, u128, u128)> {
    let ixs = vec![cu_limit(400_000), env.buy_pool_ix()];
    events_of(env, &ixs, r).into_iter().find(|(k, _)| *k == event::BUY).map(|(_, d)| {
        (rd_u64(&d, 0), rd_u64(&d, 8), rd_u64(&d, 16), rd_u64(&d, 24), rd_u64(&d, 32), rd_u64(&d, 40), rd_u128(&d, 48), rd_u128(&d, 64))
    })
}
fn line_of(entry: &[u8]) -> String {
    String::from_utf8(hunch::format::diary_line(&Entry::read(entry), b"HUNCH").as_bytes().to_vec()).unwrap()
}
fn pool_fees(env: &Env) -> (u128, u64) {
    let d = env.data(&env.damm_keys().pool);
    (rd_u128(&d, damm::TOTAL_LP_B_FEE), rd_u64(&d, damm::TOTAL_PROTOCOL_B_FEE))
}

#[test]
fn ticks_claim_and_buy_and_burn_on_the_migrated_pool() {
    let Graduated { mut env, trader: t, partner, leftover, mut cpis, .. } = adopted();
    let (lp0, _) = pool_fees(&env);
    let supply0 = env.mint_supply();
    let mut cu_ordinary = vec![];
    let mut cu_boundary = vec![];
    for b in 19..=36 {
        let r = pool_bar(&mut env, &t, b, SOL / 2);
        scan(&env, &[cu_limit(400_000), env.tick_ix()], &r, &mut cpis);
        let cu = hunch_cu(&r.logs).unwrap();
        let ev = bar_event(&env, &r);
        // the tick read DAMM v2's fee counters: lp_b + protocol_b
        let (lp, prot) = pool_fees(&env);
        assert_eq!(rd_u64(&ev, 72), lp as u64 + prot, "bar {b}: the fee counter the tick read");
        assert_eq!(rd_u16(&ev, 36), 375, "bar {b}: the live fee in the tape");
        if b % 6 == 0 {
            cu_boundary.push(cu);
            let m = memos(&r.logs);
            let e = env.last_diary();
            println!("bar {b} (hour {}): {} CU, {:?}", (H0 + b * BAR) / 3600 - H0 / 3600, cu, m);
            if b == 24 {
                assert_eq!(m.get(1).map(|s| s.as_bytes()), Some(rules::GRADUATION_LINE), "the first boundary after adoption writes the graduation line");
                assert!(rd_u16(&e, 38) & df::CHAPTER != 0);
            }
        } else {
            cu_ordinary.push(cu);
        }
    }
    let st = env.state();
    println!("pool record after hour 6: {}/{} (warm-up hours 3 and 4 not owed; curve record {}/{})", st.hits, st.n, st.prev_hits, st.prev_n);
    assert_eq!(st.n, 1, "hour 5 is the first scored hour of the pool");
    assert!(cu_ordinary.iter().all(|c| *c <= 60_000) && cu_boundary.iter().all(|c| *c <= 200_000), "K4 on the pool");

    // ---- claim_pool_fees: the budget PDA claims as the NFT owner; 33% of the LPs' fees ----
    env.set_clock(H0 + 36 * BAR + 30, 0);
    let w0 = env.token_amount(&env.budget_wsol);
    let ixs = vec![cu_limit(400_000), env.claim_pool_ix()];
    let r = ok(env.send_payer(&ixs), "claim_pool_fees");
    scan(&env, &ixs, &r, &mut cpis);
    let claim_cu = hunch_cu(&r.logs).unwrap();
    let claimed = env.token_amount(&env.budget_wsol) - w0;
    let (lp1, _) = pool_fees(&env);
    let share = claimed as f64 / (lp1 - lp0) as f64;
    println!("claim_pool_fees: {:.6} SOL = {:.3}% of the LPs' fees since migration ({claim_cu} CU)", claimed as f64 / 1e9, 100.0 * share);
    assert!((share - 0.33).abs() < 0.002, "the creator position earns 33% of the LP fees");
    assert_eq!(env.state().pool_claimed, claimed);
    // the partner's position: DAMM v2 refuses the budget as its signer
    assert!(env.send_payer(&[cu_limit(400_000), env.claim_pool_ix_for(&partner.position, &partner.nft)]).is_err());

    // ---- buy_and_burn_pool ----
    // refused: by CPI, beside another instruction, with the partner's position
    env.set_clock(H0 + 36 * BAR + 60, 0);
    let ix = env.buy_pool_ix();
    assert_eq!(code(env.send_payer(&[cu_limit(400_000), env.via_probe(&ix)])), Some(err::CALLED_BY_CPI));
    assert_eq!(code(env.send_payer(&[cu_limit(400_000), ix.clone(), memo_ix("x")])), Some(err::NOT_ALONE));
    let mut bad = ix.clone();
    bad.accounts[12].pubkey = partner.position;
    assert_eq!(code(env.send_payer(&[cu_limit(400_000), bad])), Some(err::WRONG_ACCOUNT));
    let r = ok(env.buy_pool(), "buy_and_burn_pool");
    scan(&env, &[cu_limit(400_000), env.buy_pool_ix()], &r, &mut cpis);
    let cu = hunch_cu(&r.logs).unwrap();
    let (held, spent, units, donated, own_fee, min_out, p1, p2) = buy_pool_event(&env, &r).expect("a buy");
    let moved = (p2 as f64 / p1 as f64).powi(2) - 1.0;
    println!(
        "buy_and_burn_pool: held {:.4} SOL, spent {:.4}, burned {} HUNCH of which {} the leftover, own fee {:.6}, min_out {}, price +{:.3}% ({cu} CU, {} bytes)",
        held as f64 / 1e9,
        spent as f64 / 1e9,
        units / 1_000_000,
        donated / 1_000_000,
        own_fee as f64 / 1e9,
        min_out,
        100.0 * moved,
        wire_size(&[cu_limit(400_000), cu_price(1), env.buy_pool_ix()], &env.payer.pubkey())
    );
    assert!(cu <= 250_000, "K4: buy_and_burn_pool {cu} CU");
    assert!(moved <= 0.0201 && moved > 0.0);
    assert_eq!(donated, leftover, "DBC's leftover, burned at the first buy");
    assert_eq!(env.token_amount(&env.budget_hunch()), 0);
    assert_eq!(env.mint_supply(), supply0 - units, "everything bought and the leftover burned");
    let st = env.state();
    assert_eq!((st.donated, st.burned, st.buys), (leftover, units, 1));
    assert_eq!(code(env.buy_pool()), Some(err::ALREADY_BOUGHT_THIS_HOUR));
    // the next tick takes Hunch's own trade out: with no outside trade, no volume and no move
    let r = tick_bar(&mut env, 37);
    let ev = bar_event(&env, &r);
    let ret = rd_u32(&ev, 32) as i32;
    println!("tick after the buy (Hunch alone traded): outside lamports {} per bar, outside return {ret} (Q16.16)", rd_u64(&ev, 48));
    assert_eq!(rd_u64(&ev, 48), 0);
    assert!(ret.abs() <= 2, "Hunch's own move is taken out");
    println!("pool ticks: ordinary max {} CU, boundary max {} CU; claim_pool_fees {claim_cu} CU", cu_ordinary.iter().max().unwrap(), cu_boundary.iter().max().unwrap());
    // the CPI scan over withdraw_surplus, adopt_pool, the pool's ticks, claim_pool_fees and the buy
    println!("every instruction Hunch invoked on the graduation path: {cpis:?}");
    for k in &cpis {
        assert!(ALLOWED.contains(&k.as_str()), "unexpected CPI: {k}");
    }
    for k in ["DBC creator_withdraw_surplus", "DAMM v2 claim_position_fee", "DAMM v2 swap2 mode 0", "Token burn", "Token sync_native", "Memo", "Hunch event 4"] {
        assert!(cpis.contains(k), "the scan did not reach {k}");
    }
}

/// The same hour twice: once plainly, once with an outsider doubling the pool's liquidity in the
/// transaction before the buy (a just-in-time LP). Hunch's spend is capped by the liquidity at the last tick either way.
#[test]
fn liquidity_added_just_before_a_buy_does_not_raise_the_cap() {
    let run = |jit: bool| {
        let Graduated { mut env, trader: t, .. } = adopted();
        for b in 19..=36 {
            pool_bar(&mut env, &t, b, SOL / 2);
        }
        env.donate(50 * SOL); // a budget large enough for the impact cap to bind
        let l_tick = u128_of(env.state().last_liquidity);
        env.set_clock(H0 + 36 * BAR + 40, 0);
        if jit {
            let tp = t.pubkey();
            println!("outsider's balances: {:.3} SOL of WSOL, {} HUNCH; the pool's: {:.3} SOL, {} HUNCH", env.token_amount(&ata_of(&tp, &wsol_mint())) as f64 / 1e9, env.token_amount(&ata_of(&tp, &env.pool().mint)) / 1_000_000, env.token_amount(&env.damm_keys().vault_b) as f64 / 1e9, env.token_amount(&env.damm_keys().vault_a) / 1_000_000);
            let (pos, nft, _, r) = env.create_position(&tp);
            ok(r, "create_position (outsider)");
            let ix = env.add_liquidity_ix(&tp, &pos, &nft, l_tick);
            ok(env.send(&[cu_limit(400_000), ix], &[&t]), "add_liquidity (outsider)");
        }
        let l_live = rd_u128(&env.data(&env.damm_keys().pool), damm::LIQUIDITY);
        env.set_clock(H0 + 36 * BAR + 60, 0);
        let r = ok(env.buy_pool(), "buy_and_burn_pool");
        let (_, spent, units, donated, _, _, p1, p2) = buy_pool_event(&env, &r).expect("a buy");
        let cap = rules::pool_impact_cap(p1, l_tick.min(l_live), MAX_SQRT_PRICE);
        (spent, units - donated, l_tick, l_live, cap, (p2 as f64 / p1 as f64).powi(2) - 1.0)
    };
    let (spent_a, bought_a, l_a, live_a, cap_a, move_a) = run(false);
    let (spent_b, bought_b, l_b, live_b, cap_b, move_b) = run(true);
    println!("no JIT: liquidity at the tick {l_a}, live {live_a}; spent {:.6} SOL (impact cap {:.6}), bought {bought_a}, price +{:.3}%", spent_a as f64 / 1e9, cap_a as f64 / 1e9, 100.0 * move_a);
    println!("JIT:    liquidity at the tick {l_b}, live {live_b}; spent {:.6} SOL (impact cap {:.6}), bought {bought_b}, price +{:.3}%", spent_b as f64 / 1e9, cap_b as f64 / 1e9, 100.0 * move_b);
    assert_eq!(l_a, l_b);
    assert!(live_b >= 2 * l_b - 1, "the outsider doubled the live liquidity");
    assert_eq!(spent_a, cap_a, "the impact cap binds");
    assert_eq!(spent_b, spent_a, "liquidity added in the previous transaction did not raise the cap");
    assert!(move_b < move_a, "the JIT LP only absorbed part of the move");
}

#[test]
fn meteora_changing_the_fee_and_pausing_the_pool_are_recorded_and_not_scored() {
    let Graduated { mut env, trader: t, .. } = adopted();
    for b in 19..=36 {
        pool_bar(&mut env, &t, b, SOL / 2);
    }
    assert_eq!(env.state().n, 1);
    let pool = env.damm_keys().pool;
    let set_pool = |env: &mut Env, f: &dyn Fn(&mut Vec<u8>)| {
        let mut a = env.svm.get_account(&pool).unwrap();
        f(&mut a.data);
        env.svm.set_account(pool, a).unwrap();
    };
    let outcome_at = |env: &Env| {
        let e = env.last_diary();
        (e[17], rd_u16(&e, 38), line_of(&e))
    };
    // Meteora's operators set the base fee to 1.00% (update_pool_fees writes the cliff numerator) in hour 6
    for b in 37..=54 {
        if b == 39 {
            set_pool(&mut env, &|d| wr_u64(d, damm::CLIFF_FEE_NUMERATOR, 10_000_000));
        }
        let r = pool_bar(&mut env, &t, b, SOL / 2);
        if b == 39 {
            assert_eq!(rd_u16(&env.last_tape(), 36), 100, "the tape records the new fee");
        }
        if b % 6 == 0 {
            let (o, f, line) = outcome_at(&env);
            let sig = env.signal_bytes();
            println!("bar {b} boundary: outcome {o}, flags {f:#06x}, call flags {:#04x}, memo: {}", sig[layout::sig::FLAGS], memos(&r.logs)[0]);
            match b {
                42 => {
                    assert_eq!((o, f & df::FEE_CHANGED != 0), (rules::outcome::NOT_SCORED, true), "the hour of the change");
                    assert!(line.contains("not scored, Meteora changed the pool fee to 1.00%."), "{line}");
                    assert!(sig[layout::sig::FLAGS] & sf::FEE_CHANGED != 0, "the call just made is measured against a disturbed hour");
                }
                48 => assert_eq!((o, f & df::FEE_CHANGED != 0), (rules::outcome::NOT_SCORED, true), "the hour after (its reference saw the change)"),
                54 => assert!(o == rules::outcome::HIT || o == rules::outcome::MISS, "scored again at the new fee"),
                _ => {}
            }
        }
    }
    let n_fee = env.state().n;
    // Meteora pauses the pool for bars 57 to 62
    for b in 55..=78 {
        if b == 57 {
            set_pool(&mut env, &|d| d[damm::POOL_STATUS] = 1);
            env.set_clock(H0 + b * BAR - 200, 0);
            assert!(env.trade_pool(&t, true, SOL).is_err(), "DAMM v2 refuses swaps while paused");
        }
        if b == 63 {
            set_pool(&mut env, &|d| d[damm::POOL_STATUS] = 0);
        }
        let paused = (57..=62).contains(&b);
        let r = pool_bar(&mut env, &t, b, if paused { 0 } else { SOL / 2 });
        assert_eq!(env.last_tape()[38], paused as u8, "bar {b}: the tape records the status");
        if b == 57 {
            env.set_clock(H0 + b * BAR + 60, 0);
            assert_eq!(code(env.buy_pool()), Some(err::POOL_PAUSED), "no buy while paused");
        }
        if b % 6 == 0 {
            let (o, f, line) = outcome_at(&env);
            println!("bar {b} boundary: outcome {o}, flags {f:#06x}, status {}, memo: {}", env.signal_bytes()[layout::sig::POOL_STATUS], memos(&r.logs)[0]);
            match b {
                60 | 66 | 72 => {
                    assert_eq!((o, f & df::PAUSED != 0), (rules::outcome::NOT_SCORED, true), "hour ended at bar {b}");
                    if b == 60 {
                        assert!(line.contains("not scored, Meteora paused the pool."), "{line}");
                        assert_eq!(env.signal_bytes()[layout::sig::POOL_STATUS], 1);
                    }
                }
                78 => assert!(o == rules::outcome::HIT || o == rules::outcome::MISS, "scored again after the pause"),
                _ => {}
            }
        }
    }
    let st = env.state();
    println!("pool record {}/{}, not scored {} (2 for the fee change, 3 for the pause)", st.hits, st.n, st.not_scored);
    assert_eq!(st.not_scored, 5);
    assert_eq!(st.n, n_fee + 1);

    // Meteora changes the pool's layout (an upgrade): blind, no reading, no call, no buy, the hour not owed
    let n_before = st.n;
    for b in 79..=96 {
        if b == 81 {
            set_pool(&mut env, &|d| d[0] ^= 0xff);
        }
        if b == 85 {
            set_pool(&mut env, &|d| d[0] ^= 0xff);
        }
        let r = pool_bar(&mut env, &t, b, if (81..=84).contains(&b) { 0 } else { SOL / 2 });
        let blind = (81..=84).contains(&b);
        assert_eq!(rd_u16(&env.last_tape(), 6) & rules::tf::BLIND != 0, blind, "bar {b}");
        if b == 84 {
            let line = memos(&r.logs)[0].clone();
            println!("bar 84 boundary while blind: {line}");
            assert!(line.contains("blind: the pool layout changed, no calls, no buys."));
            assert_eq!(env.signal_bytes()[layout::sig::PHASE], phase::BLIND);
            env.set_clock(H0 + 84 * BAR + 60, 0);
            assert_eq!(code(env.buy_pool()), Some(err::NO_BOUNDARY_THIS_HOUR), "no buy while blind");
        }
        if b == 90 {
            let (o, f, _) = outcome_at(&env);
            assert!(o != rules::outcome::HIT && o != rules::outcome::MISS && o != rules::outcome::FORFEIT, "the blind hour is not owed (outcome {o}, flags {f:#x})");
            assert_eq!(env.signal_bytes()[layout::sig::PHASE], phase::POOL, "back on the pool");
        }
    }
    let st = env.state();
    println!("after the blind spell: pool record {}/{} (was {n_before}), forfeits {}", st.hits, st.n, st.forfeits);
    assert_eq!(st.forfeits, 0, "Meteora's layout change costs no forfeit");
    assert_eq!(st.n, n_before + 1, "scoring resumes at the second boundary after the pool reads again");
}

/// buy_and_burn_pool keeps the curve's rule: the hour's first wait is recorded, a further call that would
/// wait again is refused and changes nothing, a call that can buy still buys, and after a buy every call
/// in the hour is refused.
#[test]
fn a_second_wait_in_an_hour_is_refused_on_the_pool_too() {
    let Graduated { mut env, trader: t, .. } = adopted();
    for b in 19..=36 {
        pool_bar(&mut env, &t, b, SOL / 2);
    }
    env.donate(SOL);
    let mine = ata_of(&t.pubkey(), &env.pool().mint);
    let snapshot = |env: &Env| (env.data(&env.state), env.signal_bytes(), env.token_amount(&env.budget_wsol), env.data(&env.damm_keys().position));
    // hour 6: a pump on DAMM v2 right before the first call: it waits on the guard
    env.set_clock(H0 + 36 * BAR + 40, 0);
    let held0 = env.token_amount(&mine);
    ok(env.trade_pool(&t, true, 20 * SOL), "pump");
    env.set_clock(H0 + 36 * BAR + 60, 0);
    ok(env.buy_pool(), "a wait");
    let st = env.state();
    assert_eq!((st.hs_reason, st.skips, st.buys), (rules::skip::GUARD, 1, 0));
    // more trades (the position's fee grows), then a call that would wait again: refused, nothing changes
    env.set_clock(H0 + 36 * BAR + 65, 0);
    ok(env.trade_pool(&t, true, SOL / 10), "a trade");
    let before = snapshot(&env);
    env.set_clock(H0 + 36 * BAR + 70, 0);
    assert_eq!(code(env.buy_pool()), Some(err::ALREADY_WAITED_THIS_HOUR));
    assert!(snapshot(&env) == before, "a refused second wait changed something");
    // the pump unwinds: the next call in the same hour buys
    let units = env.token_amount(&mine) - held0;
    env.set_clock(H0 + 36 * BAR + 75, 0);
    ok(env.trade_pool(&t, false, units), "unwind");
    env.set_clock(H0 + 36 * BAR + 90, 0);
    let r = ok(env.buy_pool(), "a buy after a wait in the same hour");
    let (_, spent, ..) = buy_pool_event(&env, &r).expect("a buy");
    let st = env.state();
    assert_eq!((st.hs_reason, st.skips, st.buys, st.hs_bought), (rules::skip::NONE, 1, 1, spent));
    // after the buy, any further call in the hour: refused as before, one that would wait included
    env.set_clock(H0 + 36 * BAR + 95, 0);
    ok(env.trade_pool(&t, true, 20 * SOL), "pump again");
    env.set_clock(H0 + 36 * BAR + 100, 0);
    assert_eq!(code(env.buy_pool()), Some(err::ALREADY_BOUGHT_THIS_HOUR));
    println!("pool, hour 6: waited on the guard once, a second wait refused, then bought {:.6} SOL; later calls refused", spent as f64 / 1e9);
}

/// buy_and_burn_pool refuses (FEE_RAISED) while Meteora's operators hold the pool's fee above the fee at
/// adoption, or on a fee Hunch cannot model (a dynamic fee), and changes nothing: the slice would pay that
/// fee to the LPs and Meteora instead of buying HUNCH. Once the fee is back, the same hour's call buys; a
/// lower fee is not refused.
#[test]
fn a_raised_fee_stops_the_pool_buy_until_it_returns() {
    let Graduated { mut env, trader: t, .. } = adopted();
    for b in 19..=36 {
        pool_bar(&mut env, &t, b, SOL / 2);
    }
    env.donate(5 * SOL);
    let pool = env.damm_keys().pool;
    let set_pool = |env: &mut Env, f: &dyn Fn(&mut Vec<u8>)| {
        let mut a = env.svm.get_account(&pool).unwrap();
        f(&mut a.data);
        env.svm.set_account(pool, a).unwrap();
    };
    let snapshot = |env: &Env| (env.data(&env.state), env.signal_bytes(), env.token_amount(&env.budget_wsol), env.data(&env.damm_keys().position), env.mint_supply());
    assert_eq!(env.state().adopt_fee_num, 37_500_000);
    env.set_clock(H0 + 36 * BAR + 60, 0);
    let before = snapshot(&env);
    let raised: [(&str, &dyn Fn(&mut Vec<u8>)); 3] = [
        ("50% (update_pool_fees writes the cliff numerator)", &|d| wr_u64(d, damm::CLIFF_FEE_NUMERATOR, 500_000_000)),
        ("one unit above 3.75%", &|d| wr_u64(d, damm::CLIFF_FEE_NUMERATOR, 37_500_001)),
        ("a dynamic fee switched on at 3.75%", &|d| {
            wr_u64(d, damm::CLIFF_FEE_NUMERATOR, 37_500_000);
            d[damm::DYNAMIC_FEE_INITIALIZED] = 1;
        }),
    ];
    for (i, (what, f)) in raised.into_iter().enumerate() {
        set_pool(&mut env, f);
        let fee = damm_fee_of(&env.data(&pool));
        // a different compute price per call keeps each transaction new
        let r = env.send_payer(&[cu_limit(400_000), cu_price(1 + i as u64), env.buy_pool_ix()]);
        assert_eq!(code(r), Some(err::FEE_RAISED), "{what}");
        assert!(snapshot(&env) == before, "a refused buy changed something ({what})");
        println!("buy_and_burn_pool refuses {what}: live fee {} bps, plain {}: error {}", fee.numerator() / 100_000, fee.plain(), err::FEE_RAISED);
    }
    // the fee returns to 3.75%: the same hour's call buys
    set_pool(&mut env, &|d| d[damm::DYNAMIC_FEE_INITIALIZED] = 0);
    let r = ok(env.buy_pool(), "buy_and_burn_pool at 3.75% again");
    let (_, spent, units, ..) = buy_pool_event(&env, &r).expect("a buy");
    println!("back at 3.75%: bought {:.6} SOL, burned {} HUNCH", spent as f64 / 1e9, units / 1_000_000);
    // a cut to 1.00% is not refused (the next hour's call runs as usual: it buys or records why it waits)
    set_pool(&mut env, &|d| wr_u64(d, damm::CLIFF_FEE_NUMERATOR, 10_000_000));
    for b in 37..=42 {
        pool_bar(&mut env, &t, b, SOL / 2);
    }
    env.set_clock(H0 + 42 * BAR + 60, 0);
    let st0 = env.state();
    ok(env.buy_pool(), "buy_and_burn_pool at 1.00%");
    let st = env.state();
    println!("at 1.00%: buys {} -> {}, waits {} -> {}", st0.buys, st.buys, st0.skips, st.skips);
    assert_eq!(st.buys + st.skips, st0.buys + st0.skips + 1);
}

/// SOL sent straight to the budget's WSOL account joins the budget (sync_native), but pool_claimed counts
/// only what the position's fee claims paid (DAMM v2's own total_claimed_b_fee on the position), in
/// claim_pool_fees and in buy_and_burn_pool alike.
#[test]
fn sol_sent_to_the_wsol_account_is_not_counted_as_position_fees() {
    /// cp-amm Position.metrics.total_claimed_b_fee (u64).
    const TOTAL_CLAIMED_B: usize = 208;
    let Graduated { mut env, trader: t, .. } = adopted();
    for b in 19..=36 {
        pool_bar(&mut env, &t, b, SOL / 2);
    }
    let position = env.damm_keys().position;
    let claimed_b = |env: &Env| rd_u64(&env.data(&position), TOTAL_CLAIMED_B);
    // claim_pool_fees with 2 SOL sent to the WSOL account first
    env.set_clock(H0 + 36 * BAR + 30, 0);
    env.donate(2 * SOL);
    let (w0, c0, p0) = (env.token_amount(&env.budget_wsol), claimed_b(&env), env.state().pool_claimed);
    ok(env.send_payer(&[cu_limit(400_000), env.claim_pool_ix()]), "claim_pool_fees");
    let (w1, c1, p1) = (env.token_amount(&env.budget_wsol), claimed_b(&env), env.state().pool_claimed);
    println!("claim_pool_fees after 2 SOL sent: WSOL +{} lamports, the position's fee claimed +{}, pool_claimed +{}", w1 - w0, c1 - c0, p1 - p0);
    assert!(c1 > c0, "the position earned fees");
    assert_eq!(w1 - w0, 2 * SOL + (c1 - c0), "the 2 SOL joined the budget");
    assert_eq!(p1 - p0, c1 - c0, "pool_claimed counts only the claim");
    // buy_and_burn_pool with 1 SOL sent first, after more trades
    env.set_clock(H0 + 36 * BAR + 40, 0);
    env.churn_pool(&t, SOL);
    env.donate(SOL);
    let (c0, p0) = (claimed_b(&env), env.state().pool_claimed);
    env.set_clock(H0 + 36 * BAR + 60, 0);
    ok(env.buy_pool(), "buy_and_burn_pool");
    let (c1, p1) = (claimed_b(&env), env.state().pool_claimed);
    println!("buy_and_burn_pool after 1 SOL sent: the position's fee claimed +{}, pool_claimed +{}", c1 - c0, p1 - p0);
    assert!(c1 > c0);
    assert_eq!(p1 - p0, c1 - c0, "pool_claimed counts only the claim");
}

/// Every instruction Hunch invoked directly in a withdrawal transaction (paid by the authority).
fn withdraw_cpis(env: &Env, r: &TransactionMetadata) -> BTreeSet<String> {
    let ixs = env.withdraw_ixs(0);
    let keys = env.message_keys(&ixs, &env.authority.pubkey());
    let mut seen = BTreeSet::new();
    // only Hunch's own instruction's inner instructions (the WSOL account's creation has its own)
    let at = ixs.iter().position(|ix| ix.program_id == env.hunch).unwrap();
    for ii in r.inner_instructions[at].iter().filter(|ii| ii.stack_height == 2) {
        let pid = keys[ii.instruction.program_id_index as usize];
        let d = &ii.instruction.data;
        seen.insert(if pid == damm() && d[..8] == hunch::ids::DAMM_CLAIM_POSITION_FEE {
            "DAMM v2 claim_position_fee".to_string()
        } else if pid == dbc() && d[..8] == hunch::ids::CLAIM_CREATOR_TRADING_FEE2 {
            "DBC claim_creator_trading_fee2".to_string()
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

/// withdraw_budget on the migrated DAMM v2 pool: it claims only Hunch's own position's fee and moves exactly
/// the budget's WSOL plus that fee to the developer; the developer's (the partner's) locked position and its
/// NFT, the pool account (reserves, liquidity, price, fee counters) and the coin account holding DBC's leftover
/// are byte for byte untouched; refused with another position, by anyone else, by CPI; and the hourly
/// buy_and_burn_pool after it, in the same hour and the next, does exactly what the deployed build does.
#[test]
fn the_developer_s_withdrawal_on_the_migrated_pool() {
    let Graduated { mut env, trader: t, partner, leftover, .. } = adopted();
    for b in 19..=36 {
        pool_bar(&mut env, &t, b, SOL / 2);
    }
    env.set_clock(H0 + 36 * BAR + 30, 0);
    let auth = env.authority.pubkey();
    let ak = env.authority.insecure_clone();
    let old = old_so();
    let lam = |env: &Env, a: &Address| env.svm.get_account(a).map(|x| x.lamports).unwrap_or(0);
    let k = env.damm_keys().clone();
    // what the position's fee claim pays now, measured on a twin by claim_pool_fees alone
    let mut probe = env.twin(None);
    let w0 = probe.token_amount(&probe.budget_wsol);
    ok(probe.send_payer(&[cu_limit(400_000), probe.claim_pool_ix()]), "claim_pool_fees on a twin");
    let position_fee = probe.token_amount(&probe.budget_wsol) - w0;
    let rent = env.svm.minimum_balance_for_rent_exemption(165);
    let wsol_before = lam(&env, &env.budget_wsol) - rent;
    let (partner_pos, partner_nft) = (env.data(&partner.position), env.data(&partner.nft));
    let pool0 = env.data(&k.pool);
    let (va0, vb0) = (env.token_amount(&k.vault_a), env.token_amount(&k.vault_b));
    let dev0 = lam(&env, &auth);
    let supply0 = env.mint_supply();
    let coin0 = env.data(&env.budget_hunch());
    let raw0 = env.data(&env.state);
    let st0 = env.state();
    assert_eq!(env.token_amount(&env.budget_hunch()), leftover, "DBC's leftover waits in the budget's coin account");
    assert!(wsol_before > 0 && position_fee > 0, "the surplus waits in the budget and the position has earned");

    // ---- refusals, each on a twin: another position, anyone else, by CPI ----
    let mut e = env.twin(None);
    ok(e.send(&[create_ata_ix(&auth, &auth, &wsol_mint())], &[&ak]), "the developer's WSOL account");
    let dest = e.dev_wsol();
    let mut ix = e.withdraw_ix(&auth, &dest, 0);
    ix.accounts[19].pubkey = partner.position;
    ix.accounts[20].pubkey = partner.nft;
    assert_eq!(code(e.send(&[cu_limit(400_000), ix], &[&ak])), Some(err::WRONG_ACCOUNT), "the developer's own position");
    let payer = e.payer.pubkey();
    ok(e.send_payer(&[create_ata_ix(&payer, &payer, &wsol_mint())]), "the payer's WSOL account");
    let ix = e.withdraw_ix(&payer, &ata_of(&payer, &wsol_mint()), 0);
    assert_eq!(code(e.send_payer(&[cu_limit(400_000), ix])), Some(err::NOT_AUTHORITY));
    let ix = e.via_probe(&e.withdraw_ix(&auth, &dest, 0));
    assert_eq!(code(e.send(&[cu_limit(400_000), ix], &[&ak])), Some(err::CALLED_BY_CPI));
    // while Meteora has the pool paused: what DAMM v2's claim does then
    let mut e = env.twin(None);
    let mut a = e.svm.get_account(&k.pool).unwrap();
    a.data[damm::POOL_STATUS] = 1;
    e.svm.set_account(k.pool, a).unwrap();
    let paused = e.withdraw(0);
    println!(
        "withdraw_budget while the pool is paused: {}",
        match &paused {
            Ok(r) => format!("allowed, {:.6} SOL", e.withdraw_event(r).unwrap().amount as f64 / 1e9),
            Err(f) => format!("refused, {:?}", f.err),
        }
    );

    // ---- the withdrawal ----
    let r = ok(env.withdraw(0), "withdraw_budget on the pool");
    let ev = env.withdraw_event(&r).expect("event 6");
    println!(
        "withdraw_budget on DAMM v2: {:.6} SOL = {:.6} in the budget's WSOL (the surplus) + {:.6} position fee claimed, {} CU",
        ev.amount as f64 / 1e9,
        wsol_before as f64 / 1e9,
        ev.claimed as f64 / 1e9,
        hunch_cu(&r.logs).unwrap()
    );
    assert_eq!(ev.claimed, position_fee, "the claim paid what claim_pool_fees would have");
    assert_eq!((ev.amount, ev.left), (wsol_before + position_fee, 0));
    assert_eq!(env.token_amount(&env.budget_wsol), 0);
    assert_eq!(lam(&env, &auth), dev0 + ev.amount - 5_000, "the developer receives the amount, less the network fee");
    assert_eq!((env.data(&partner.position), env.data(&partner.nft)), (partner_pos, partner_nft), "the developer's position and its NFT are untouched");
    assert_eq!(env.data(&k.pool), pool0, "the pool account (reserves, liquidity, price, fee counters) is untouched");
    assert_eq!((env.token_amount(&k.vault_a), vb0 - env.token_amount(&k.vault_b)), (va0, position_fee), "the vaults paid the position's fee and nothing more");
    assert_eq!(env.data(&env.budget_hunch()), coin0, "the coin account (DBC's leftover) is left as it was");
    assert_eq!(env.mint_supply(), supply0);
    let st = env.state();
    assert_eq!((st.pool_claimed - st0.pool_claimed, st.claimed), (ev.claimed, st0.claimed));
    assert_eq!((st.withdrawn, st.withdrawals), (ev.amount, 1));
    let raw = env.data(&env.state);
    let pc = std::mem::offset_of!(State, pool_claimed);
    for i in (0..STATE_LEN).filter(|i| !(1216..1232).contains(i) && !(pc..pc + 8).contains(i)) {
        assert_eq!(raw[i], raw0[i], "State byte {i} changed");
    }
    let want = String::from_utf8(hunch::format::withdraw_line(ev.amount, b"HUNCH").as_bytes().to_vec()).unwrap();
    assert_eq!(memos(&r.logs), vec![want.clone()]);
    println!("memo: {want}");
    let allowed: BTreeSet<String> = ["DAMM v2 claim_position_fee", "Token sync_native", "Token transfer", "Memo", "Hunch event 6"].iter().map(|s| s.to_string()).collect();
    assert_eq!(withdraw_cpis(&env, &r), allowed);

    // ---- the hourly buy_and_burn_pool after it, on the fees that come after: the deployed build's result ----
    env.set_clock(H0 + 36 * BAR + 40, 0);
    env.churn_pool(&t, 2 * SOL);
    let mut b = env.twin(Some(&old));
    let mut watched = env.watched();
    watched.extend([partner.position, partner.nft, ata_of(&t.pubkey(), &wsol_mint()), ata_of(&t.pubkey(), &env.pool().mint)]);
    for e in [&mut env, &mut b] {
        e.set_clock(H0 + 36 * BAR + 60, 0);
    }
    let (ra, rb) = (env.buy_pool(), b.buy_pool());
    assert_eq!(ra.is_ok(), rb.is_ok());
    assert_eq!(env.differences(&b, &watched), Vec::<Address>::new(), "the hourly pool buy after the withdrawal differs from the deployed build");
    let st = env.state();
    println!(
        "hour 6, after the withdrawal: the hourly pool buy {} {:.6} SOL of {:.6} held (the new position fee), burning DBC's leftover too, as the deployed build does",
        if st.hs_reason == 0 { "bought" } else { "waited" },
        st.hs_bought as f64 / 1e9,
        st.hs_held as f64 / 1e9
    );
    assert_eq!(st.hs_reason, 0, "it bought");
    assert_eq!(env.token_amount(&env.budget_hunch()), 0, "and burned everything, the leftover included");
    for bb in 37..=42 {
        pool_bar(&mut env, &t, bb, SOL / 2);
        pool_bar(&mut b, &t, bb, SOL / 2);
    }
    for e in [&mut env, &mut b] {
        e.set_clock(H0 + 42 * BAR + 60, 0);
    }
    let (ra, rb) = (env.buy_pool(), b.buy_pool());
    assert_eq!(ra.is_ok(), rb.is_ok());
    assert_eq!(env.differences(&b, &watched), Vec::<Address>::new(), "hour 7's pool buy differs from the deployed build");
    let st = env.state();
    println!("hour 7: the hourly pool buy {} {:.6} SOL in both builds", if st.hs_reason == 0 { "bought" } else { "waited" }, st.hs_bought as f64 / 1e9);
    assert_eq!(st.last_buy_hour, ((H0 + 42 * BAR) / 3600) as u32, "hour 7 bought");
}

/// withdraw_budget while graduating (the curve complete and migrated, before adopt_pool): the DBC claim and
/// the surplus withdraw_surplus put in the budget; DBC's partner and protocol fees untouched; adopt_pool
/// still works after it.
#[test]
fn a_withdrawal_while_graduating_takes_the_surplus_and_adoption_still_works() {
    let Graduated { mut env, creator, surplus, .. } = graduated();
    assert_eq!(env.state().phase, phase::GRADUATING);
    env.set_clock(H0 + 18 * BAR + 200, 0);
    let auth = env.authority.pubkey();
    let p = env.pool().pool;
    let rd = |env: &Env, at: usize| rd_u64(&env.data(&p), at);
    let rent = env.svm.minimum_balance_for_rent_exemption(165);
    let wsol = env.svm.get_account(&env.budget_wsol).unwrap().lamports - rent;
    let (creator_fee, partner0, protocol0) = (rd(&env, pool::CREATOR_QUOTE_FEE), rd(&env, POOL_PARTNER_QUOTE_FEE), rd(&env, POOL_PROTOCOL_QUOTE_FEE));
    let claimed0 = env.state().claimed;
    let dev0 = env.svm.get_account(&auth).unwrap().lamports;
    let r = env.withdraw(0).unwrap_or_else(|f| panic!("withdraw_budget while graduating: {:?}\n{}", f.err, f.meta.logs.join("\n")));
    let ev = env.withdraw_event(&r).unwrap();
    println!(
        "withdraw_budget while graduating: {:.6} SOL ({:.6} in the WSOL account, of which {:.6} the surplus, + {:.6} creator fee claimed on DBC)",
        ev.amount as f64 / 1e9,
        wsol as f64 / 1e9,
        surplus as f64 / 1e9,
        ev.claimed as f64 / 1e9
    );
    assert_eq!((ev.claimed, ev.amount), (creator_fee, wsol + creator_fee));
    assert_eq!(env.svm.get_account(&auth).unwrap().lamports, dev0 + ev.amount - 5_000);
    assert_eq!((rd(&env, POOL_PARTNER_QUOTE_FEE), rd(&env, POOL_PROTOCOL_QUOTE_FEE)), (partner0, protocol0));
    assert_eq!(env.state().claimed - claimed0, creator_fee);
    // adopt_pool after it, as usual
    env.set_clock(H0 + 18 * BAR + 300, 0);
    ok(env.adopt_pool(creator), "adopt_pool after a withdrawal");
    assert_eq!(env.state().phase, phase::POOL);
}
