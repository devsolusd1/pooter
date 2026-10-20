#!/bin/bash
# Stage 2 and graduation: every test, locally. Run it from WSL or Linux:  bash hunch/programs/test-v1.sh
#
# 1. node scripts/export-vectors.mjs  the JS reference (site/core/net.js + chain.js) writes the K2 vectors
#    (chapter 0 = the stage-1 vectors, byte for byte; version one with chapters), the chain replay and the
#    pool replay (graduation, adopt_pool, 7 days on DAMM v2 with Meteora changing the fee and pausing);
#    node tests/export-pool-rules.mjs   adopt_pool's bar and the pool buy's fee refusal, case by case;
# 2. hunch-net tests                 K2: the Rust network against net.js on every bar;
# 3. hunch host tests                 the rules (curve and DAMM v2 math, the fee fields, formatting) as plain Rust;
# 4. build.sh                         the program and the CPI probe for SBF;
# 5. hunch-tests (LiteSVM)            the program next to Meteora DBC's, DAMM v2's, SPL Token-2022's and SPL
#                                     Memo's mainnet bytecode: the chain replay against chain.js on every
#                                     tick (also under the adversarial crankers' schedules), K6 (the replay
#                                     with Hunch's real buys injected), a test per rule (one wait per hour,
#                                     the ticker), DBC's first swap with min fee (only the developer's buy
#                                     in the pool-creating transaction gets it), the adversarial
#                                     suite (K4, K5), the pool replay against chain.js, and graduation (K9):
#                                     a real DBC migration into DAMM v2 with Hunch as the creator,
#                                     withdraw_surplus, withdraw_leftover, adopt_pool (and the outside pools
#                                     and positions it refuses), ticks, claim_pool_fees and buy_and_burn_pool
#                                     on the migrated pool, liquidity added just before a buy, Meteora's fee
#                                     change and pause; withdraw_budget, the developer's withdrawal, on the
#                                     curve (withdraw.rs), while graduating and on the pool (graduation.rs):
#                                     only the upgrade authority and never by CPI, exactly the budget's WSOL
#                                     plus the fee it claims and nothing else, the refusals, and the hourly
#                                     buy after it compared byte for byte with the deployed build
#                                     (OLD_HUNCH_SO, ~/hunch-target/final/hunch.so, sha256 face57dd...; dumped
#                                     from mainnet when missing); and upgrade_live.rs: the new build on the
#                                     LIVE mainnet accounts (cloned read-only by tests/clone-live.mjs into
#                                     $target/live-clone when missing; LIVE_REFRESH=1 clones them again);
# 6. k5-caps.mjs, k7-crank.mjs        K5's cap report over the replay; K7: the record against the rule, the
#                                     majority and the luck band on 7 coins, and what every cranker
#                                     strategy (seconds, skips) does to it.
# Meteora DBC is Meteora's current mainnet build by default: mainnet-programs/dbc-0.2.2.so (DBC 0.2.2, live since
# 2026-10-16, sha256 e2bfc853...ad47; the script says so when the file's hash is another). DBC_SO=<path> runs
# everything against another build, for example DBC_SO=$HOME/hunch-target/mainnet-programs/dbc.so (the build
# before 0.2.2). HUNCH_TARGET moves the build outputs, MAINNET_PROGRAMS and MAINNET_ACCOUNTS the dumped files.
# Meteora DBC and DAMM v2, SPL Token-2022, Metaplex Token Metadata and SPL Memo are dumped from mainnet once,
# and two accounts cloned (the DAMM v2 config of DBC's Customizable migration, and DBC's pool authority with
# its balance, which DBC's migration borrows rent from): read-only, public RPC, into the target folder.
# Every key is a throwaway made in memory; nothing is sent to any cluster.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
target="${HUNCH_TARGET:-$HOME/hunch-target}"
offline="${CARGO_OFFLINE:---offline}"

(cd .. && node scripts/export-vectors.mjs)
node tests/export-pool-rules.mjs
(cd hunch-net && CARGO_TARGET_DIR="$target/k2/net" cargo test --release $offline -- --nocapture)
(cd hunch && CARGO_TARGET_DIR="$target/hunch-host" cargo test --release $offline -- --nocapture)
bash ./build.sh

mainnet="${MAINNET_PROGRAMS:-$target/mainnet-programs}"
accounts="${MAINNET_ACCOUNTS:-$target/mainnet-accounts}"
mkdir -p "$mainnet" "$accounts"
dbc_022_sha=e2bfc853c1a1778dd8ee40ea9a0f3edf5587442360c57c685e7e3024ad0cad47
[ -s "$mainnet/dbc-0.2.2.so" ] || solana program dump -u m dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN "$mainnet/dbc-0.2.2.so"
[ -s "$mainnet/mpl_token_metadata.so" ] || solana program dump -u m metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s "$mainnet/mpl_token_metadata.so"
[ -s "$mainnet/memo.so" ] || solana program dump -u m MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr "$mainnet/memo.so"
[ -s "$mainnet/damm_v2.so" ] || solana program dump -u m cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG "$mainnet/damm_v2.so"
[ -s "$mainnet/token_2022.so" ] || solana program dump -u m TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb "$mainnet/token_2022.so"
[ -s "$accounts/damm_config_customizable.json" ] || solana account -u m A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck --output json-compact > "$accounts/damm_config_customizable.json"
[ -s "$accounts/dbc_pool_authority.json" ] || solana account -u m FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM --output json-compact > "$accounts/dbc_pool_authority.json"
# what the LiteSVM suite loads (lib.rs reads these; the defaults there are under ~/hunch-target)
export DBC_SO="${DBC_SO:-$mainnet/dbc-0.2.2.so}"
export HUNCH_SO="${HUNCH_SO:-$target/deploy/hunch.so}" HUNCH_WIDE_SO="${HUNCH_WIDE_SO:-$target/deploy-wide/hunch.so}"
export PROBE_SO="${PROBE_SO:-$target/deploy/hunch_cpi_probe.so}" MPL_SO="$mainnet/mpl_token_metadata.so" MEMO_SO="$mainnet/memo.so"
export DAMM_SO="$mainnet/damm_v2.so" TOKEN_2022_SO="$mainnet/token_2022.so" MAINNET_ACCOUNTS="$accounts"
# the deployed build (the twin tests run it beside the new one) and the live accounts (upgrade_live.rs)
deployed_sha=face57ddb4950ebf82a787cc5c80266dd2a631353c160e40ee2bfca0eb480f0f
export OLD_HUNCH_SO="${OLD_HUNCH_SO:-$HOME/hunch-target/final/hunch.so}"
if [ ! -s "$OLD_HUNCH_SO" ]; then
  OLD_HUNCH_SO="$mainnet/pooter-deployed.so"
  [ -s "$OLD_HUNCH_SO" ] || solana program dump -u m CCw2e4MgnZ3opEddVX4oJHkWJye81gARqEC1535hPaY1 "$OLD_HUNCH_SO"
fi
echo "deployed build: $OLD_HUNCH_SO, sha256 $(sha256sum "$OLD_HUNCH_SO" | cut -c1-64) (mainnet's since 2026-10-20: $deployed_sha)"
export LIVE_ACCOUNTS="${LIVE_ACCOUNTS:-$target/live-clone}"
if [ -n "${LIVE_REFRESH:-}" ] || [ ! -s "$LIVE_ACCOUNTS/index.json" ]; then node tests/clone-live.mjs "$LIVE_ACCOUNTS"; fi
dbc_sha="$(sha256sum "$DBC_SO" | cut -c1-64)"
if [ "$dbc_sha" = "$dbc_022_sha" ]; then echo "DBC: $DBC_SO, sha256 $dbc_sha (Meteora's 0.2.2 build)"
else echo "DBC: $DBC_SO, sha256 $dbc_sha: NOT the 0.2.2 build ($dbc_022_sha)"; fi
for so in damm_v2 token_2022; do echo "$so bytecode sha256: $(sha256sum "$mainnet/$so.so" | cut -c1-64)"; done
echo "Hunch: $HUNCH_SO, $(stat -c %s "$HUNCH_SO") bytes, sha256 $(sha256sum "$HUNCH_SO" | cut -c1-64)"

(cd hunch-tests && CARGO_TARGET_DIR="$target/tests" cargo test --release $offline -- --nocapture --test-threads 4)
(cd .. && node scripts/k5-caps.mjs && node scripts/k7-crank.mjs)
