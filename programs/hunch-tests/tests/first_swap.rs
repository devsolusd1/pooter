//! DBC's "first swap with min fee" against Meteora DBC's mainnet bytecode (0.2.2 by default): may the
//! developer's optional first buy ride inside the pool-creating transaction at the schedule's 3.75% end
//! instead of the 50% opening fee, without any outside trader ever getting that fee?
//!
//! DBC's source (release 0.2.2, commit 91e696e: `instructions/swap/process_swap.rs` and
//! `state/virtual_pool.rs`): a swap pays the min fee only when the config's flag is on, the pool has never
//! been swapped (`has_swap == 0`, set by the first swap), there is no referral account, the instructions
//! sysvar is passed, the top-level instruction being executed is DBC's own (not a CPI), and an earlier
//! instruction of the same transaction is DBC's initialize_virtual_pool_* naming this pool. A pool is
//! initialized once, in a transaction its creator and its mint keypair sign, so only that transaction can
//! hold the discounted swap. These tests check it against the bytecode: adopt_curve accepts the flag; the
//! creation transaction (create pool, the creator transfer to the budget PDA, the buy, in either order)
//! pays 3.75% and leaves the budget PDA as the creator; every other swap pays the opening schedule.

use {
    hunch::{
        layout::*,
        rules::{self, compiled, FEE_DENOM},
    },
    hunch_net::SEED,
    hunch_tests::*,
    solana_address::Address,
    solana_instruction::{account_meta::AccountMeta, Instruction},
    solana_signer::Signer,
};

const H0: i64 = 1_790_002_800; // a UTC hour start
const T_ACT: i64 = H0 - 400; // the pool's activation (the creation transaction's clock)
const SOL: u64 = 1_000_000_000;

/// The pool's fee counters (trading + protocol, in SOL): what every swap has paid in fees.
fn fee_total(env: &Env, at: &Address) -> u64 {
    let d = env.data(at);
    rd_u64(&d, pool::TOTAL_TRADING_QUOTE_FEE) + rd_u64(&d, pool::TOTAL_PROTOCOL_QUOTE_FEE)
}

/// DBC's fee on a buy of `amount` lamports (fee on input, rounded up) at fee numerator `num`.
fn fee_of(amount: u64, num: u64) -> u64 {
    (amount as u128 * num as u128).div_ceil(FEE_DENOM) as u64
}

/// The opening schedule's fee numerator at `now` (50% at activation, 9.25 points less each second, 3.75%
/// from the fifth second).
fn schedule_at(now: i64) -> u64 {
    rules::live_fee_numerator(compiled::CLIFF_FEE_NUMERATOR, compiled::NUMBER_OF_PERIOD as u64, compiled::PERIOD_FREQUENCY, compiled::REDUCTION_FACTOR, T_ACT as u64, now)
}

/// A swap that asks for the min fee: DBC reads the instructions sysvar as its one extra account.
fn with_sysvar(mut ix: Instruction) -> Instruction {
    ix.accounts.push(AccountMeta::new_readonly(ix_sysvar(), false));
    ix
}

/// The payer (the developer: pool creator and fee claimer) with `sol` wrapped in its WSOL account.
fn fund_developer(env: &mut Env, sol: u64) {
    let p = env.payer.pubkey();
    let wsol = ata_of(&p, &wsol_mint());
    env.send_payer(&[create_ata_ix(&p, &p, &wsol_mint()), system_transfer(&p, &wsol, sol), sync_native_ix(&wsol)]).unwrap();
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Order {
    /// create pool, transfer the creator to the budget PDA, then the developer's buy
    TransferThenBuy,
    /// create pool, the developer's buy, then the transfer
    BuyThenTransfer,
    /// create pool and the transfer, no buy
    NoBuy,
    /// create pool, the transfer, then two buys by the developer
    TwoBuys,
}

/// The pool-creating transaction of `variant` in `order`, sent at T_ACT. Returns the pool's keys, the
/// fees its buys paid (the pool's fee counters after it) and its legacy wire size.
fn create(env: &mut Env, variant: &str, order: Order, buy: u64) -> (PoolKeys, u64, usize) {
    env.set_clock(T_ACT, 2_000);
    fund_developer(env, 10 * SOL);
    let (keys, pool_ixs, transfer) = env.prepare_pool(variant);
    let dev = env.payer.pubkey();
    let buy_ix = with_sysvar(dbc_swap_ix(&keys, &dev, true, buy, 0));
    let mut ixs = vec![cu_limit(1_400_000)];
    ixs.extend(pool_ixs);
    match order {
        Order::TransferThenBuy => ixs.extend([transfer, create_ata_ix(&dev, &dev, &keys.mint), buy_ix]),
        Order::BuyThenTransfer => ixs.extend([create_ata_ix(&dev, &dev, &keys.mint), buy_ix, transfer]),
        Order::NoBuy => ixs.push(transfer),
        Order::TwoBuys => ixs.extend([transfer, create_ata_ix(&dev, &dev, &keys.mint), buy_ix.clone(), buy_ix]),
    }
    let size = wire_size(&ixs, &dev);
    let payer = env.payer.insecure_clone();
    let mint_kp = env.mint_kp.insecure_clone();
    env.send(&ixs, &[&payer, &mint_kp]).unwrap_or_else(|e| panic!("creation transaction {order:?}: {:?}\n{}", e.err, e.meta.logs.join("\n")));
    let fees = fee_total(env, &keys.pool);
    (keys, fees, size)
}

#[test]
fn the_min_fee_reaches_only_the_developer_s_buy_in_the_creation_transaction() {
    let buy = SOL;
    let min_fee = fee_of(buy, compiled::ENDING_FEE_NUMERATOR);
    assert_eq!(schedule_at(T_ACT), compiled::CLIFF_FEE_NUMERATOR, "50% at the activation second");
    for order in [Order::TransferThenBuy, Order::BuyThenTransfer] {
        let mut env = Env::new(T_ACT - 100);
        let (keys, fees, size) = create(&mut env, "minfee", order, buy);
        assert_eq!(env.data(&keys.config)[config::ENABLE_FIRST_SWAP_WITH_MIN_FEE], 1, "the config carries the flag");
        // the developer's buy paid the min fee (3.75%), not the opening fee (50% at this second)
        assert_eq!(fees, min_fee, "{order:?}: the developer's buy paid {fees} lamports ({:.2}%)", 100.0 * fees as f64 / buy as f64);
        // and the budget PDA is the pool's creator
        let p = env.data(&keys.pool);
        assert_eq!(&p[pool::CREATOR..pool::CREATOR + 32], env.budget.as_ref(), "{order:?}: the budget PDA is the creator");
        println!("{order:?}: the developer's 1 SOL buy paid {fees} lamports (3.75%; the opening fee at that second is 50%), creator = budget PDA, legacy wire size {size} bytes");
        // Hunch accepts the config (the flag is no longer refused) and adopts the pool
        env.initialize(&keys.mint, SEED).unwrap();
        let pool_key = keys.pool;
        env.adopt(keys).unwrap_or_else(|e| panic!("adopt: {:?}\n{}", e.err, e.meta.logs.join("\n")));
        assert_eq!(env.state().phase, rules::phase::CURVE);
        // an outside trader in the opening seconds pays the schedule, with the sysvar passed or not
        let t = env.trader(100 * SOL);
        for (dt, sysvar) in [(0i64, true), (1, false), (2, true), (4, true), (5, true), (60, false)] {
            let now = T_ACT + dt;
            env.set_clock(now, 2_000 + dt as u64);
            let before = fee_total(&env, &pool_key);
            let mut ix = env.swap_ix(&t.pubkey(), true, buy, 0);
            if sysvar {
                ix = with_sysvar(ix);
            }
            let tk = t.insecure_clone();
            env.send(&[cu_limit(400_000), ix], &[&tk]).unwrap_or_else(|e| panic!("outside buy at +{dt}s: {:?}\n{}", e.err, e.meta.logs.join("\n")));
            let paid = fee_total(&env, &pool_key) - before;
            assert_eq!(paid, fee_of(buy, schedule_at(now)), "{order:?}: an outside buy at +{dt} s (sysvar {sysvar})");
            if order == Order::TransferThenBuy {
                println!("  outside buy at +{dt} s (instructions sysvar passed: {sysvar}): paid {:.2}%, the schedule's", 100.0 * paid as f64 / buy as f64);
            }
        }
    }
}

#[test]
fn no_outside_swap_gets_the_min_fee() {
    let buy = SOL;
    let (min_fee, opening) = (fee_of(buy, compiled::ENDING_FEE_NUMERATOR), fee_of(buy, schedule_at(T_ACT)));
    // (1) no developer buy: the pool's first-ever swap is an outsider's, in its own transaction, with the
    // sysvar passed: it pays the opening fee (no initialize of this pool precedes it in its transaction)
    let mut env = Env::new(T_ACT - 100);
    let (keys, fees, _) = create(&mut env, "minfee", Order::NoBuy, buy);
    assert_eq!(fees, 0, "no swap yet");
    env.initialize(&keys.mint, SEED).unwrap();
    let pool_key = keys.pool;
    env.adopt(keys).unwrap();
    let t = env.trader(100 * SOL);
    for dt in [0i64, 3] {
        env.set_clock(T_ACT + dt, 2_100 + dt as u64);
        let before = fee_total(&env, &pool_key);
        let tk = t.insecure_clone();
        env.send(&[cu_limit(400_000), with_sysvar(env.swap_ix(&t.pubkey(), true, buy, 0))], &[&tk]).unwrap();
        let paid = fee_total(&env, &pool_key) - before;
        assert_eq!(paid, fee_of(buy, schedule_at(T_ACT + dt)), "outside first swap at +{dt} s");
        println!("no developer buy: the pool's first swap, an outsider's at +{dt} s with the sysvar, paid {:.2}% (the schedule)", 100.0 * paid as f64 / buy as f64);
    }

    // (2) two buys in the creation transaction: only the first gets the min fee, the second pays 50%
    let mut env = Env::new(T_ACT - 100);
    let (_, fees, _) = create(&mut env, "minfee", Order::TwoBuys, buy);
    assert_eq!(fees, min_fee + opening, "two buys in the creation transaction: the first at 3.75%, the second at 50%");
    println!("two buys in the creation transaction: {fees} lamports of fees = 3.75% + 50% of 1 SOL");

    // (3) the flag off (the only config Hunch accepted before): the same creation transaction pays the opening fee
    let mut env = Env::new(T_ACT - 100);
    let (keys, fees, _) = create(&mut env, "good", Order::TransferThenBuy, buy);
    assert_eq!(env.data(&keys.config)[config::ENABLE_FIRST_SWAP_WITH_MIN_FEE], 0);
    assert_eq!(fees, opening, "without the flag the developer's buy pays the opening fee");
    println!("flag off: the developer's buy in the creation transaction paid {:.2}%", 100.0 * fees as f64 / buy as f64);
}
