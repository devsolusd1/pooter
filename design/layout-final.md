# Hunch program: the final layout

For the engineers who update the site decoder, the crank and the launch scripts. Everything here is
what the program in `hunch/programs/hunch` does as of 2026-10-16. The State table is generated from the
Rust struct (`offset_of!`) by the host test `state_layout_table_is_generated_from_the_struct` in
`programs/hunch/tests/host.rs`, and that test fails if this file does not hold the table exactly. The host
test `layout_doc_lists_every_instruction_tag_and_error_code` checks the tag and error tables below against
`ids.rs` the same way.

Rerun both: `wsl -e bash -lc 'cd /mnt/c/Users/John/RafinhaProject/hunch/programs/hunch && CARGO_TARGET_DIR=$HOME/hunch-target/<your folder>/host cargo test --release --offline -- --nocapture'`

## Added 2026-10-20: `withdraw_budget` (tag 12)

The developer chose to have the budget go to their wallet, so they can buy the coin and burn it by hand,
while the hourly buy keeps running on whatever fee arrives later. The site says so publicly. Full description
under "Instructions", tag 12.

- **No existing field moved; `STATE_LEN` stays 1,248.** Three fields come out of the reserve, which the live
  State holds at zero (checked on a clone of the live accounts), so they start at "never withdrawn":
  `withdrawn` (u64, 1,216), `withdrawals` (u32, 1,224), `last_withdraw_hour` (u32, 1,228). The reserve
  shrinks to 16 bytes at 1,232.
- **No existing instruction changed** (accounts, data or results). The LiteSVM tests run the hourly buy before
  and after a withdrawal beside the deployed build (sha256 face57dd...) from identical accounts: every byte
  matches.
- New errors: 31 `NOTHING_TO_WITHDRAW`, 32 `AMOUNT_TOO_HIGH`. New event kind 6 (`WITHDRAW`). New memo line
  (format.rs `withdraw_line`).
- What the other parts need. `site/decode.js`: the three fields in `ST` and `decodeState` (done; the page shows
  the lifetime total in "Buy and burn" and in Questions). `crank/`: nothing (it never sends tag 12; after a
  withdrawal the hourly buy usually waits with "below 0.01 SOL" until new fees arrive, which it already
  handles). `site/core/chain.js`: nothing (it does not read State bytes). Tools: `scripts/withdraw-budget.mjs`,
  `scripts/burn.mjs`, `scripts/claim-dev-fees.mjs`, `scripts/upgrade-program.sh`, rehearsed together by
  `scripts/rehearse-withdraw.sh` on a local validator holding the live accounts.

## Changed after review (2026-10-16)

Three review findings were applied to the program. No instruction's accounts or data changed. One State
field was added from the reserve, no offset moved, and there is one new error code.

1. **adopt_pool's bar no longer reads the pool's permanent lock.** Before, the position had to hold 25% of
   the DAMM v2 pool's `permanent_lock_liquidity`. Anyone can raise that for good by creating a position,
   adding liquidity and locking it permanently; all three are permissionless. An outsider who locked about
   34% of the pool's liquidity between the migration and adopt_pool pushed Hunch's 33% position to 24.6%,
   and adopt_pool then refused it forever. Now the position must hold, locked for good, at least 25% of the
   liquidity DBC's migration builds from two values `adopt_curve` pins from the DBC config:
   `L_mig = migration_quote_threshold x 2^128 / (migration_sqrt_price - 4295048016)`, floored (DAMM v2's
   full-range formula; 4295048016 is DAMM v2's minimum sqrt price). Nothing in the pool can move it.
   Measured against Meteora's mainnet bytecode (LiteSVM), DBC's migration opens the pool at exactly the
   config's migration sqrt price and fills it to 99.8% of the threshold. Hunch's real position is 32.934% of
   `L_mig` on the test curve and on the launch config. An outsider's 34% lock (32.6 SOL plus the HUNCH beside
   it, on the launch config) no longer blocks adoption. A dust position handed to the budget, or one a unit
   under 25% of `L_mig`, is still error 26. A position someone gives the budget with at least 25% of `L_mig`
   locked could be adopted instead of the real one. That costs the giver, on the launch config, about 24 SOL
   plus the HUNCH beside it, locked for good. claim_pool_fees can still claim the real position's fees,
   because it accepts any position whose NFT the budget holds.
   - **State:** `migration_sqrt_price` (u128, low word first) at offset **1,200**, 16 bytes, written once by
     adopt_curve. The reserve shrinks to 32 bytes at 1,216. `STATE_LEN` stays 1,248.
   - A state that went through adopt_curve under an earlier build has this field at 0, and its adopt_pool
     refuses every position (26). Nothing is launched, so this only affects local rehearsals: run
     initialize and adopt_curve again with this build.
2. **buy_and_burn_pool refuses a raised fee: new error 30, `FEE_RAISED`.** It is refused when the pool's
   live fee numerator is above `adopt_fee_num` (the fee at adoption, 3.75%), or the fee is not one Hunch can
   model (a dynamic fee, or a fee schedule still running). Before, the hourly slice simply paid whatever
   Meteora's operators set, up to 50% or 99%, to the LPs and Meteora. The check comes right after the pause
   check (27), before the claim, and the whole call changes nothing. The budget keeps accruing until the
   fee is back; a call in the same hour then buys. A lower fee is not refused.
3. **`claimed` and `pool_claimed` count only what the claim paid.** claim_curve_fees, buy_and_burn_curve,
   claim_pool_fees and buy_and_burn_pool now read the "before" balance after sync_native. SOL sent straight
   to the budget's WSOL account still joins the budget and is still spent on buys, but it is no longer
   counted as a creator fee or position fee claimed.

What the site and crank engineers need to do:

- **`site/decode.js`:** optional, add `migration_sqrt_price: 1200` (u128 LE) to `ST`. Add error name 30
  `FEE_RAISED` if the page shows error names. `claimed` and `pool_claimed` no longer include SOL sent to
  the WSOL account.
- **`crank/crank.mjs`:** add 30 to the buy loop's settled codes beside 27 (`POOL_PAUSED`). A call refused
  with 30 changes nothing, and only Meteora's operators can bring the fee back, so treat the hour as
  settled and log the live fee. Simulate before sending, as for 28.
- **`crank/hunch-program.mjs`:** `ERR[30] = "FEE_RAISED"`. `adoptPoolIx` is unchanged. In
  `adoptPoolCandidates`, sorting by locked size still puts Hunch's 33% first, ahead of an outsider's
  position. To mirror the program's bar, use `positionShareOk(locked, state.migration_quote_threshold,
  state.migration_sqrt_price)` from `site/core/chain.js`. `decodeState` can read the new field at 1,200.
- **`scripts/init-hunch.mjs`:** after adopt_curve, read `migration_sqrt_price` back and compare it with the
  DBC config's (u128 at config offset 280). It must not be 0.
- **`launch/`:** nothing changes.

Build: `~/hunch-target/final/hunch.so` (in WSL), 196,864 bytes, sha256
`face57ddb4950ebf82a787cc5c80266dd2a631353c160e40ee2bfca0eb480f0f`; a rebuild from a clean target gives
the same hash. adopt_pool now costs about 30,500 to 33,500 compute units, up from 6,841, because of the
256-bit division. It runs once, and the crank gives it 200,000. Every other instruction moved by less than
140 units.

## What changed since the stage-2 layout (920 bytes)

- **State is 1,248 bytes** (`STATE_LEN`). Every stage-2 field keeps its offset (0 to 863). The graduation
  fields fill 864 to 1,183. The ticker takes the first 16 bytes of the reserve, at 1,184, and
  `migration_sqrt_price` the next 16, at 1,200 (see "Changed after review"). 32 bytes of reserve remain
  (1,216 to 1,247).
- **initialize takes the ticker** (1 to 10 characters, A-Z and 0-9). The diary line names it, for example
  `bought 0.083 SOL, burned 1.20M HOURHOG.` The account tags (`HUNCHSTA`, `HUNCHMDL` and the others) stay
  as they are.
- **One wait per hour.** Once a buy call has waited in a UTC hour, a further call in that hour that would
  wait again fails with error 28, `ALREADY_WAITED_THIS_HOUR`, and changes nothing: no claim, no counter,
  no event. A call that can buy still buys. After a buy, every call in the hour fails with 15, as before.
  So `skips` counts hours that waited, not crank calls.
- **The first-swap-with-min-fee flag is allowed.** adopt_curve accepts a DBC config with
  `enable_first_swap_with_min_fee` at 0 or 1 (any other value is error 10). See the last section.

The other accounts are unchanged: model 1,288 bytes, tape 6,936, open call 160, diary 9,240, brain book
5,920 at creation (it grows by 5,888 at a time).

## State (PDA `["state"]`, 1,248 bytes, little-endian, `repr(C)`)

The `since` column says when each field arrived: `stage 2` (the 920-byte layout), `graduation` (adopt_pool
and the pool phase), `ticker (final)` (the program engineer's final change), `review fix (2026-10-16)` (the
adoption bar, see "Changed after review"). `pad*` and `reserved` are always zero.

<!-- generated: state table -->
| offset | size | field | type | since |
|---:|---:|---|---|---|
| 0 | 8 | `tag` | `[u8;8]` | stage 2 |
| 8 | 1 | `version` | `u8` | stage 2 |
| 9 | 1 | `phase` | `u8` | stage 2 |
| 10 | 1 | `chapter` | `u8` | stage 2 |
| 11 | 1 | `brain_source` | `u8` | stage 2 |
| 12 | 1 | `budget_bump` | `u8` | stage 2 |
| 13 | 1 | `event_bump` | `u8` | stage 2 |
| 14 | 1 | `last_outcome` | `u8` | stage 2 |
| 15 | 1 | `blind` | `u8` | stage 2 |
| 16 | 32 | `mint` | `[u8;32]` | stage 2 |
| 48 | 32 | `pool` | `[u8;32]` | stage 2 |
| 80 | 32 | `config` | `[u8;32]` | stage 2 |
| 112 | 32 | `base_vault` | `[u8;32]` | stage 2 |
| 144 | 32 | `quote_vault` | `[u8;32]` | stage 2 |
| 176 | 32 | `budget` | `[u8;32]` | stage 2 |
| 208 | 32 | `budget_wsol` | `[u8;32]` | stage 2 |
| 240 | 32 | `budget_hunch` | `[u8;32]` | stage 2 |
| 272 | 32 | `model` | `[u8;32]` | stage 2 |
| 304 | 32 | `tape` | `[u8;32]` | stage 2 |
| 336 | 32 | `signal` | `[u8;32]` | stage 2 |
| 368 | 32 | `diary` | `[u8;32]` | stage 2 |
| 400 | 32 | `book` | `[u8;32]` | stage 2 |
| 432 | 32 | `event_authority` | `[u8;32]` | stage 2 |
| 464 | 32 | `brain_hash` | `[u8;32]` | stage 2 |
| 496 | 4 | `seed` | `u32` | stage 2 |
| 500 | 4 | `launch_hour` | `u32` | stage 2 |
| 504 | 8 | `launch_ts` | `i64` | stage 2 |
| 512 | 8 | `activation_point` | `u64` | stage 2 |
| 520 | 8 | `cliff_fee` | `u64` | stage 2 |
| 528 | 8 | `reduction` | `u64` | stage 2 |
| 536 | 8 | `period_frequency` | `u64` | stage 2 |
| 544 | 8 | `n_periods` | `u64` | stage 2 |
| 552 | 8 | `migration_quote_threshold` | `u64` | stage 2 |
| 560 | 8 | `ticks` | `u64` | stage 2 |
| 568 | 8 | `last_tick_ts` | `i64` | stage 2 |
| 576 | 4 | `last_tick_bar` | `u32` | stage 2 |
| 580 | 4 | `start_hour` | `u32` | stage 2 |
| 584 | 16 | `last_sp` | `[u64;2]` | stage 2 |
| 600 | 8 | `last_fee_total` | `u64` | stage 2 |
| 608 | 8 | `cum` | `u64` | stage 2 |
| 616 | 8 | `own_fee` | `u64` | stage 2 |
| 624 | 8 | `own_ratio` | `u64` | stage 2 |
| 632 | 8 | `own_lamports` | `u64` | stage 2 |
| 640 | 4 | `last_attempt_bar` | `u32` | stage 2 |
| 644 | 4 | `blind_until_hour` | `u32` | stage 2 |
| 648 | 4 | `last_boundary_hour` | `u32` | stage 2 |
| 652 | 4 | `recent_len` | `u32` | stage 2 |
| 656 | 8 | `last_boundary_ts` | `i64` | stage 2 |
| 664 | 8 | `last_boundary_cum` | `u64` | stage 2 |
| 672 | 8 | `ref_vol` | `u64` | stage 2 |
| 680 | 8 | `ref_secs` | `u64` | stage 2 |
| 688 | 8 | `hour_vol_prev` | `u64` | stage 2 |
| 696 | 4 | `recent_bits` | `u32` | stage 2 |
| 700 | 4 | `last_record_day` | `u32` | stage 2 |
| 704 | 4 | `n` | `u32` | stage 2 |
| 708 | 4 | `hits` | `u32` | stage 2 |
| 712 | 4 | `rule_hits` | `u32` | stage 2 |
| 716 | 4 | `busier_hours` | `u32` | stage 2 |
| 720 | 4 | `quieter_calls` | `u32` | stage 2 |
| 724 | 4 | `quieter_hits` | `u32` | stage 2 |
| 728 | 4 | `forfeits` | `u32` | stage 2 |
| 732 | 4 | `not_scored` | `u32` | stage 2 |
| 736 | 4 | `last_buy_hour` | `u32` | stage 2 |
| 740 | 4 | `buy_day` | `u32` | stage 2 |
| 744 | 8 | `last_buy_ts` | `i64` | stage 2 |
| 752 | 4 | `day_buys` | `u32` | stage 2 |
| 756 | 1 | `hs_reason` | `u8` | stage 2 |
| 757 | 1 | `hs_detail` | `u8` | stage 2 |
| 758 | 2 | `pad0` | `[u8;2]` | stage 2 |
| 760 | 8 | `day_spent` | `u64` | stage 2 |
| 768 | 8 | `day_cap` | `u64` | stage 2 |
| 776 | 4 | `hs_hour` | `u32` | stage 2 |
| 780 | 4 | `pad1` | `u32` | stage 2 |
| 784 | 8 | `hs_bought` | `u64` | stage 2 |
| 792 | 8 | `hs_burned` | `u64` | stage 2 |
| 800 | 8 | `hs_held` | `u64` | stage 2 |
| 808 | 8 | `spent` | `u64` | stage 2 |
| 816 | 8 | `bought_units` | `u64` | stage 2 |
| 824 | 8 | `burned` | `u64` | stage 2 |
| 832 | 8 | `donated` | `u64` | stage 2 |
| 840 | 4 | `buys` | `u32` | stage 2 |
| 844 | 4 | `skips` | `u32` | stage 2 |
| 848 | 8 | `claimed` | `u64` | stage 2 |
| 856 | 4 | `last_missed_bar` | `u32` | stage 2 |
| 860 | 4 | `pad2` | `u32` | stage 2 |
| 864 | 32 | `damm_pool` | `[u8;32]` | graduation |
| 896 | 32 | `damm_config` | `[u8;32]` | graduation |
| 928 | 32 | `token_a_vault` | `[u8;32]` | graduation |
| 960 | 32 | `token_b_vault` | `[u8;32]` | graduation |
| 992 | 32 | `position` | `[u8;32]` | graduation |
| 1024 | 32 | `position_nft` | `[u8;32]` | graduation |
| 1056 | 32 | `position_mint` | `[u8;32]` | graduation |
| 1088 | 16 | `last_liquidity` | `[u64;2]` | graduation |
| 1104 | 8 | `adopt_fee_fp` | `u64` | graduation |
| 1112 | 8 | `last_fee_fp` | `u64` | graduation |
| 1120 | 8 | `adopt_fee_num` | `u64` | graduation |
| 1128 | 8 | `surplus` | `u64` | graduation |
| 1136 | 8 | `pool_claimed` | `u64` | graduation |
| 1144 | 8 | `adopt_ts` | `i64` | graduation |
| 1152 | 4 | `adopt_hour` | `u32` | graduation |
| 1156 | 4 | `pool_warm_end` | `u32` | graduation |
| 1160 | 4 | `prev_n` | `u32` | graduation |
| 1164 | 4 | `prev_hits` | `u32` | graduation |
| 1168 | 4 | `prev_rule_hits` | `u32` | graduation |
| 1172 | 4 | `prev_forfeits` | `u32` | graduation |
| 1176 | 4 | `prev_not_scored` | `u32` | graduation |
| 1180 | 1 | `last_status` | `u8` | graduation |
| 1181 | 1 | `dist_cur` | `u8` | graduation |
| 1182 | 1 | `dist_prev` | `u8` | graduation |
| 1183 | 1 | `grad_line` | `u8` | graduation |
| 1184 | 16 | `ticker` | `[u8;16]` | ticker (final) |
| 1200 | 16 | `migration_sqrt_price` | `[u64;2]` | review fix (2026-10-16) |
| 1216 | 8 | `withdrawn` | `u64` | withdraw_budget (2026-10-20) |
| 1224 | 4 | `withdrawals` | `u32` | withdraw_budget (2026-10-20) |
| 1228 | 4 | `last_withdraw_hour` | `u32` | withdraw_budget (2026-10-20) |
| 1232 | 16 | `reserved` | `[u64;2]` | reserve |
| 1248 | | (end: STATE_LEN = 1248) | | |

**`withdrawn`, `withdrawals`, `last_withdraw_hour`** (offsets 1,216, 1,224 and 1,228): the lamports the
developer has moved from the budget to their wallet with `withdraw_budget` (tag 12), in all; how many times;
and the unix hour of the last time. All three are 0 until the first withdrawal (they come from the reserve,
which the live State held at zero). They are not part of `spent`, `burned` or `buys`, which count only what
the program itself bought and burned.

**`ticker`** (offset 1,184, 16 bytes): ASCII, A-Z and 0-9 only, 1 to 10 characters, zero-padded. The first
zero byte ends it. initialize writes it once and nothing changes it after.

**`migration_sqrt_price`** (offset 1,200, 16 bytes, u128 LE, low word first): the DBC config's
`migration_sqrt_price` (config offset 280), pinned by adopt_curve beside `migration_quote_threshold`. adopt_pool's
bar is 25% of `migration_quote_threshold x 2^128 / (migration_sqrt_price - 4295048016)`. It is 0 until
adopt_curve runs.

How the graduation fields are used:

| field | meaning |
|---|---|
| `damm_pool`, `damm_config`, `token_a_vault`, `token_b_vault` | the DAMM v2 pool that DBC's migration made, its config and its two vaults (A = the coin, B = WSOL) |
| `position`, `position_nft`, `position_mint` | Hunch's position in it, the Token-2022 account that holds its NFT (owned by the budget PDA), and the NFT's mint |
| `last_liquidity` | u128 (low word first): the pool's liquidity at the last landed tick; the impact cap uses the smaller of it and the live one |
| `adopt_fee_fp`, `last_fee_fp` | the first 8 bytes (u64 LE) of SHA-256 over pool bytes `[8..80] ++ [484..487]`, at adoption and at the last tick |
| `adopt_fee_num` | the live fee numerator at adoption (1e9 = 100%) |
| `surplus`, `pool_claimed` | lamports withdraw_surplus paid into the budget; lamports the position's fee claims paid (SOL sent straight to the WSOL account is not counted; the same holds for `claimed` on the curve) |
| `adopt_ts`, `adopt_hour` | when adopt_pool ran (unix seconds, unix hour) |
| `pool_warm_end` | the first unix hour owed a score in the pool phase (adoption hour + 2) |
| `prev_n` ... `prev_not_scored` | the curve phase's record, kept when the pool phase starts its own |
| `last_status` | the pool's status at the last tick (0 trading, 1 paused) |
| `dist_cur`, `dist_prev` | what Meteora did in the interval being measured and the one before: bit 1 the fee changed (or cannot be modelled), bit 2 paused |
| `grad_line` | 1 until the first boundary tick after adoption writes the graduation memo |

## Instructions

The first byte of the instruction data is the tag. Every instruction except `initialize`, `load_brain` and
`withdraw_budget` is the tag byte alone. `(w)` means writable, `(s)` means signer.

| tag | name |
|---|---|
| 0 | `initialize` |
| 1 | `load_brain` |
| 2 | `adopt_curve` |
| 3 | `tick` |
| 4 | `buy_and_burn_curve` |
| 5 | `claim_curve_fees` |
| 6 | `read_call` |
| 7 | `grow_brain_book` |
| 8 | `withdraw_surplus` |
| 9 | `adopt_pool` |
| 10 | `buy_and_burn_pool` |
| 11 | `claim_pool_fees` |
| 12 | `withdraw_budget` |
| 0xE4 | `event` |

### Addresses

PDAs of the Hunch program: state `["state"]`, model `["model"]`, tape `["tape"]`, open call `["signal"]`,
diary `["diary"]`, brain book `["brains"]`, budget `["budget"]`, event authority `["__event_authority"]`.
programdata is the loader's PDA `[program id]` under `BPFLoaderUpgradeab1e11111111111111111111111`. The
budget's WSOL and coin accounts are the budget's associated token accounts (SPL Token) for WSOL and for the
mint.

### 0 `initialize`: once, by the upgrade authority, before the token exists

Data, exactly `47 + n` bytes:

| offset | size | field |
|---:|---:|---|
| 0 | 1 | tag, 0 |
| 1 | 32 | the coin's mint address |
| 33 | 4 | seed, u32 LE (12346 is the launch seed) |
| 37 | 9 | bumps, in order: programdata, state, model, tape, signal, diary, book, budget, event authority; each must be the canonical bump (`find_program_address`), or `InvalidSeeds` |
| 46 | 1 | n, the ticker's length, 1 to 10 |
| 47 | n | the ticker, ASCII A-Z and 0-9, no padding |

A data length other than `47 + data[46]` (the old 46-byte layout included) is `InvalidInstructionData`.
A ticker that is empty, longer than 10, or holds anything but A-Z and 0-9 (lowercase, `-`, `.`, `$`, space)
is error 29, `BAD_TICKER`, and nothing is created. The signer is checked first (error 6), then the ticker.

Accounts: 0 authority (s, w, pays the rent), 1 programdata, 2 state (w), 3 model (w), 4 tape (w), 5 open call
(w), 6 diary (w), 7 brain book (w), 8 budget, 9 budget WSOL account (w), 10 WSOL mint, 11 system program,
12 token program, 13 associated token program, 14 event authority.

### 1 `load_brain`: optional, by the upgrade authority, before adopt_curve

Data: tag, the programdata bump (u8), then the 169 weights as i32 LE (676 bytes); 678 bytes in all.
Accounts: 0 authority (s), 1 programdata, 2 state (w), 3 model (w).

### 2 `adopt_curve`: anyone, once, while the curve is live

Accounts: 0 payer (s, w), 1 state (w), 2 open call (w), 3 brain book (w), 4 DBC pool, 5 DBC config, 6 the
coin's mint, 7 budget, 8 budget's coin account (w, created here, the payer pays), 9 system program,
10 token program, 11 associated token program.

### 3 `tick`: anyone, top level and alone (ComputeBudget instructions allowed), first 30 seconds of each 10-minute bar

Accounts: 0 state (w), 1 model (w), 2 tape (w), 3 open call (w), 4 diary (w), 5 brain book (w), 6 the DBC
pool (after adopt_pool: the DAMM v2 pool), 7 budget WSOL account, 8 instructions sysvar, 9 SPL Memo
program, 10 event authority, 11 the Hunch program.

### 4 `buy_and_burn_curve`: anyone, top level and alone, after the hour's boundary tick, while the curve is live

Accounts: 0 state (w), 1 open call (w), 2 tape, 3 budget, 4 budget WSOL (w), 5 budget coin account (w),
6 the coin's mint (w), 7 WSOL mint, 8 DBC pool (w), 9 DBC config, 10 DBC base vault (w), 11 DBC quote vault
(w), 12 DBC pool authority, 13 DBC event authority, 14 DBC program, 15 token program, 16 instructions
sysvar, 17 Hunch event authority, 18 the Hunch program.

Outcomes in an hour: the first call either buys (event 4) or waits and records why (event 5, `skips` +1,
`hs_hour`/`hs_reason`). After a wait, a call that would wait again fails with 28 and changes nothing; a call
that can buy buys. After a buy, every call fails with 15.

### 5 `claim_curve_fees`: anyone, after adoption

Accounts: 0 state (w), 1 budget, 2 budget WSOL (w), 3 budget coin account (w), 4 the coin's mint, 5 WSOL mint,
6 DBC pool (w), 7 DBC config, 8 DBC base vault (w), 9 DBC quote vault (w), 10 DBC pool authority, 11 DBC
event authority, 12 DBC program, 13 token program.

### 6 `read_call`: anyone, top level or by CPI

Accounts: 0 open call, 1 instructions sysvar. Returns the 160-byte open call as return data.

### 7 `grow_brain_book`: anyone, when fewer than 30 free daily records remain

Accounts: 0 payer (s, w), 1 state, 2 brain book (w), 3 system program.

### 8 `withdraw_surplus`: anyone, once the curve is complete

Accounts: 0 state (w), 1 budget, 2 budget WSOL (w), 3 WSOL mint, 4 DBC pool (w), 5 DBC config, 6 DBC quote
vault (w), 7 DBC pool authority, 8 DBC event authority, 9 DBC program, 10 token program.

### 9 `adopt_pool`: anyone, once, after the DBC pool reports migrated

Accounts: 0 state (w), 1 open call (w), 2 DBC pool, 3 DAMM v2 pool, 4 DAMM v2 config, 5 Hunch's position,
6 the position NFT's token account, 7 budget.

The position must be in that pool, its NFT account must be Token-2022, held by the budget with an amount of
1, and it must hold, locked for good, at least 25% of `migration_quote_threshold x 2^128 /
(migration_sqrt_price - 4295048016)`, both values as adopt_curve pinned them. Otherwise it is error 26.
Hunch's real position is 32.93% of that. The pool's own liquidity and permanent lock are not read for the
bar, so an outsider's liquidity, withdrawable or locked for good, cannot block adoption.

### 10 `buy_and_burn_pool`: anyone, top level and alone, after the hour's boundary tick, in the pool phase

Accounts: 0 state (w), 1 open call (w), 2 tape, 3 budget, 4 budget WSOL (w), 5 budget coin account (w), 6 the
coin's mint (w), 7 WSOL mint, 8 DAMM v2 pool (w), 9 DAMM v2 pool authority, 10 token A vault (w), 11 token B
vault (w), 12 position (w), 13 position NFT account, 14 DAMM v2 event authority, 15 DAMM v2 program,
16 token program, 17 instructions sysvar, 18 Hunch event authority, 19 the Hunch program.

The same one-wait-per-hour rule as tag 4. It also fails with 27 while Meteora has the pool paused, and with
30 while the pool's fee is above `adopt_fee_num` or is not one Hunch can model (a dynamic fee, or a fee
schedule still running). In both cases it changes nothing, and a later call in the hour can buy once that
has passed.

### 11 `claim_pool_fees`: anyone, in the pool phase

Accounts: 0 state (w), 1 budget, 2 budget WSOL (w), 3 budget coin account (w), 4 the coin's mint, 5 WSOL mint,
6 DAMM v2 pool, 7 DAMM v2 pool authority, 8 token A vault (w), 9 token B vault (w), 10 position (w), 11 position
NFT account, 12 DAMM v2 event authority, 13 DAMM v2 program, 14 token program.

### 12 `withdraw_budget`: the upgrade authority only, top level (never by CPI), in the curve, graduating or pool phase

Added 2026-10-20. The developer moves the budget to their own wallet. They say they use it to buy the coin
and burn it by hand; the program does not check what happens to the SOL after it leaves.

Data, exactly 10 bytes (anything else is `InvalidInstructionData`):

| offset | size | field |
|---:|---:|---|
| 0 | 1 | tag, 12 |
| 1 | 1 | the programdata bump (the loader's PDA `[program id]`), as initialize takes it |
| 2 | 8 | the amount in lamports, u64 LE; 0 means the whole balance |

Accounts, the first 15 in every phase: 0 the upgrade authority (s), 1 programdata, 2 state (w), 3 open call
(w), 4 budget, 5 budget WSOL (w), 6 budget coin account (w; Meteora's claim names it, Hunch does not move
it), 7 the coin's mint, 8 WSOL mint, 9 the signer's WSOL account (w: an SPL Token account of WSOL whose owner
is the signer, error 4 otherwise), 10 token program, 11 instructions sysvar, 12 SPL Memo program, 13 Hunch
event authority, 14 the Hunch program. Then, on the curve and while graduating: 15 DBC pool (w), 16 DBC
config, 17 DBC base vault (w), 18 DBC quote vault (w), 19 DBC pool authority, 20 DBC event authority, 21 DBC
program (22 accounts). In the pool phase: 15 DAMM v2 pool, 16 DAMM v2 pool authority, 17 token A vault (w),
18 token B vault (w), 19 Hunch's adopted position (w), 20 its NFT account, 21 DAMM v2 event authority,
22 DAMM v2 program (23 accounts). The phase is read from State; the accounts must be the pinned ones (error 4).

Order of checks: data length; called by CPI (1) or not the top-level instruction being run (3); the signer
and ProgramData (6, exactly initialize's check: ProgramData at the loader's PDA with this bump, owned by the
loader, naming the signer as upgrade authority); the program, memo, open call and event authority accounts
(4); the destination (4); the phase (8 before adoption); the pinned pool accounts (4). Other instructions may
share the transaction (the developer's script creates its WSOL account first and closes it after, so the SOL
arrives as plain SOL).

Then: sync_native on the budget's WSOL account; the claim, as the hourly buy makes it (curve and graduating:
DBC `claim_creator_trading_fee2`, the budget signing as the pool's creator; pool: DAMM v2
`claim_position_fee` on Hunch's own position, the budget signing as its NFT's owner); `held` = the WSOL
account's amount after the claim. `held` = 0 is error 31. The amount (all of `held` when the data says 0)
above `held` is error 32. Then one SPL Token `transfer` of the amount from the budget's WSOL account to the
signer's, signed by the budget PDA. The budget's WSOL and coin accounts stay open and pinned; the coin account
is not touched.

Writes: `withdrawn` (+ amount), `withdrawals` (+1), `last_withdraw_hour`; what the claim paid, in `claimed`
(curve, graduating) or `pool_claimed` (pool), as the hourly buy counts it; the open call's `budget` (what is
left in the WSOL account, plus anything DBC still holds as creator fee). It never writes `hs_*`, `spent`,
`burned`, `buys`, `bought_units`, `last_buy_hour`, `last_buy_ts`, `buy_day`, `day_buys`, `day_spent`,
`day_cap`, `skips`, the tape, the diary or the brain book. The hourly buy in the same hour or later runs as it
would have with that budget (the LiteSVM tests compare it byte for byte with the deployed build from the
same accounts).

Event 6 (`WITHDRAW`), 76 bytes after the kind: amount u64, held after the claim u64, claimed u64, left in the
budget's WSOL u64, lifetime `withdrawn` u64, `withdrawals` u32, the signer's address [32]. Memo (SPL Memo by
CPI, ticker from State), for example `the developer withdrew 5.381 SOL from my budget to their wallet. They
say they use it to buy POOTER and burn it by hand.` (the amount truncated to 3 decimals).

What it never moves: DBC's partner fee (the config's fee claimer's, the developer's own) and protocol fee,
the pool's reserves, every other DAMM v2 position (the developer's locked one included), and anything of the
signer's: its lamports change only by the transaction fee and the WSOL it receives.

While Meteora has the DAMM v2 pool paused, the withdrawal still works: DAMM v2 allows the position's fee claim
then (checked in LiteSVM against the mainnet bytecode). The hourly buy is refused while paused (27), as before.
In the pool phase, creator fee still owed on the old DBC curve is not claimed by tag 12;
`scripts/withdraw-budget.mjs` puts a `claim_curve_fees` (tag 5) before it in the same transaction when there is
some.

### 0xE4 `event`: self-CPI only

Hunch's events as inner instructions: data `[0xE4, kind, payload...]`, accounts 0 event authority (s),
1 instructions sysvar. Kinds: 1 bar, 2 diary entry, 3 weights, 4 buy, 5 wait, 6 withdrawal
(withdraw_budget). Any other caller gets error 23. A refused second wait emits nothing (the transaction fails).

## Errors

`ProgramError::Custom(code)`:

| code | name | meaning |
|---:|---|---|
| 1 | `CALLED_BY_CPI` | tick or a buy was called by another program |
| 2 | `NOT_ALONE` | the transaction holds another instruction that is not ComputeBudget |
| 3 | `NOT_TOP_LEVEL` | the top-level instruction being run is not Hunch's |
| 4 | `WRONG_ACCOUNT` | an account is not the one expected (address, owner, size or tag) |
| 6 | `NOT_AUTHORITY` | the signer is not the program's upgrade authority (initialize, load_brain, withdraw_budget) |
| 7 | `ALREADY_INITIALIZED` | initialize already ran |
| 8 | `WRONG_PHASE` | not allowed in the current phase (before adoption, after it, while graduating) |
| 9 | `POOL_MISMATCH` | adopt_curve: the pool is not Hunch's (mint, creator not the budget PDA, migrated, layout) |
| 10 | `CONFIG_MISMATCH` | adopt_curve: the DBC config differs from the compiled values |
| 11 | `OUTSIDE_WINDOW` | tick: outside the first 30 seconds of the bar |
| 12 | `ALREADY_TICKED` | tick: this bar already has its tick |
| 13 | `TOO_EARLY` | tick: the 5-second opening schedule is not over |
| 14 | `NO_BOUNDARY_THIS_HOUR` | buy: this hour's boundary tick has not landed (or the pool is blind) |
| 15 | `ALREADY_BOUGHT_THIS_HOUR` | buy: there was already a buy this UTC hour |
| 16 | `TOO_SOON` | buy: less than 30 minutes since the previous buy |
| 17 | `CURVE_COMPLETE` | buy_and_burn_curve: the curve is complete (graduation is next) |
| 18 | `PRICE_MOVED_TOO_MUCH` | buy: the swap moved sqrt_price by more than 1.0101x; everything reverts |
| 19 | `BAD_BRAIN` | load_brain: a frozen part differs from its launch value, or a weight is out of range |
| 20 | `BOOK_HAS_ROOM` | grow_brain_book: the book still has room for a month |
| 21 | `BLIND` | buy: the pool's layout is not the one adopted |
| 22 | `MATH` | arithmetic out of range (declared, not raised by the current code) |
| 23 | `NOT_EVENT_AUTHORITY` | event: not Hunch's own self-CPI |
| 24 | `NOT_MIGRATED` | adopt_pool: the DBC pool has not migrated yet |
| 25 | `OUTSIDE_POOL` | adopt_pool: the DAMM v2 pool is not the one DBC's migration made for this pool |
| 26 | `NOT_OUR_POSITION` | adopt_pool: the position is not Hunch's (pool, NFT owner, amount, or less than 25% of the migration's liquidity locked for good) |
| 27 | `POOL_PAUSED` | buy_and_burn_pool: Meteora has the pool paused |
| 28 | `ALREADY_WAITED_THIS_HOUR` | buy (either phase): this hour already recorded a wait and this call would wait again; nothing changed. A call in the same hour that can buy is still allowed |
| 29 | `BAD_TICKER` | initialize: the ticker is not 1 to 10 characters of A-Z and 0-9 |
| 30 | `FEE_RAISED` | buy_and_burn_pool: the pool's fee is above the fee at adoption (`adopt_fee_num`), or one Hunch cannot model (a dynamic fee, a fee schedule still running); nothing changed, the budget waits for the fee to return. A lower fee is not refused |
| 31 | `NOTHING_TO_WITHDRAW` | withdraw_budget: the budget's WSOL account holds nothing, even after the claim |
| 32 | `AMOUNT_TOO_HIGH` | withdraw_budget: the amount asked for is more than the budget's WSOL account holds after the claim |

Code 5 is unused (it was the stage-1 proof's `NOTHING_TO_SPEND`). The runtime's own errors also appear:
`InvalidInstructionData` (unknown tag, or initialize's or load_brain's data length), `NotEnoughAccountKeys`,
`InvalidSeeds` (initialize with a non-canonical bump, or a bad programdata bump).

## The first-swap-with-min-fee flag: allowed

`check_config` (adopt_curve) now accepts `enable_first_swap_with_min_fee` (DBC config byte 365) at 0 or 1.
It is the program's only adoption check of the DBC config. adopt_pool reads no DBC config; it uses the
threshold and migration sqrt price that adopt_curve pinned from it.

Why it is safe. In DBC's source (release 0.2.2, commit `91e696e`, `instructions/swap/process_swap.rs` and
`state/virtual_pool.rs`) a swap pays the min fee (the fee schedule's end, 3.75% here) only when all of these
hold: the config's flag is on; the pool has never been swapped (`has_swap == 0`, which the first swap sets);
no referral account; the instructions sysvar is passed as the swap's one extra account; the top-level
instruction being run is DBC's own (not a CPI); and an earlier instruction of the same transaction is DBC's
`initialize_virtual_pool_*` naming this pool. A pool is initialized once, in a transaction that its creator
and its mint keypair sign. So only the first swap in the pool-creating transaction can pay it. No outside
trader can. The LiteSVM tests in `programs/hunch-tests/tests/first_swap.rs` check this against the 0.2.2
mainnet bytecode:

- a creation transaction holding create pool, the creator transfer to the budget PDA and a 1 SOL developer
  buy (in either order) paid 37,500,000 lamports (3.75%, where the opening fee at that second is 50%) and
  left the budget PDA as the pool's creator; adopt_curve then accepted the config;
- outside buys at +0, 1, 2, 4, 5 and 60 seconds paid the schedule (50%, 40.75%, 31.5%, 13%, 3.75%,
  3.75%), with or without the sysvar;
- with no developer buy, the pool's first swap, an outsider's with the sysvar, paid the schedule;
- a second buy in the creation transaction paid 50%;
- with the flag off, the developer's buy in the creation transaction paid 50%.

That transaction (compute-unit limit, create pool as SDK 1.5.13 builds it, transfer, the developer's coin
account, the buy) was 904 bytes as a legacy transaction, with the developer's WSOL wrapped beforehand.

## What each consumer must change

**`site/decode.js`**
- `STATE_LEN` 920 to 1,248. Add the graduation offsets and `ticker: 1184` to `ST` (from the table above).
- Decode `ticker` as ASCII up to its first zero byte, and pass it on: `diaryLine(entry, state.ticker)` (it
  defaults to `"HUNCH"`). Use it wherever the page prints the coin's ticker.
- Error names, if the page shows any: 28 `ALREADY_WAITED_THIS_HOUR`, 29 `BAD_TICKER`, 30 `FEE_RAISED`.
- Optionally `migration_sqrt_price: 1200` (u128) in `ST` (see "Changed after review").
- `skips` now counts hours that waited (at most one per hour), not calls.

**`crank/hunch-program.mjs`** (and `crank/crank.mjs`)
- `initializeIx(a, authority, mint, seed, ticker)`: append the length byte and the ticker to the data
  (`47 + n` bytes); refuse a ticker that fails `/^[A-Z0-9]{1,10}$/` before building it.
- `decodeState`: `ticker` at 1,184 (16 bytes); `STATE_LEN` is 1,248.
- `ERR`: add 28 `ALREADY_WAITED_THIS_HOUR`, 29 `BAD_TICKER`, 30 `FEE_RAISED`.
- `crank.mjs` buy loop: 30 joins the settled codes beside 27 (see "Changed after review").
- `adoptionProblems`: the "no first-swap-with-min-fee" line must accept 0 or 1.
- `crank.mjs` buy loop (around line 220, the retry after a wait): a retry that would wait again now fails
  with 28 and still costs its transaction fee. Simulate before sending a retry, treat 28 as "waited this
  hour, try again later in the hour if something may have changed (the guard, the tape)", and never loop on it.

**`scripts/init-hunch.mjs`**
- Take the ticker (token.json's symbol, upper case), check it with the same rule, pass it to
  `initializeIx`, print it in the plan, and after sending read `state.ticker` back and compare.
- STEP=adopt: refuse when `state.ticker` differs from token.json's symbol (the diary would name another coin).
  After adopt_curve, `state.migration_sqrt_price` must equal the DBC config's (offset 280) and not be 0.

**`launch/launch.mjs`**
- `enableFirstSwapWithMinFee`: true when `devBuySol` is above 0 (the program accepts 0 or 1). The
  `configDifferences` row "the first-trade fee rule" must expect the chosen value instead of 0.
- Step 2, with a developer buy: in the pool-creating transaction, after createPool
  (`initialize_virtual_pool_with_spl_token`) and with transferPoolCreator to the budget PDA before or after
  it, create the developer's coin account, then DBC `swap2` (buy, ExactIn) with the instructions sysvar
  (`Sysvar1nstructions1111111111111111111111111`) as the one account after the 15 named ones and no
  referral (DBC's own id in the referral slot). Only that first swap gets 3.75%; wrap the developer's SOL
  before, or add the WSOL account, transfer and sync_native to the same transaction and measure its size.
- Refuse step 2 unless the simulation reads back pool.creator = the budget PDA and fee counters of 3.75% of
  the buy, and unless Hunch's state holds this mint and `state.ticker` equals token.json's symbol.
