#!/bin/bash
# Launch day, rehearsed in the user's order on a LOCAL validator (never devnet or mainnet), with Meteora's
# real mainnet bytecode and throwaway keys made for the run:
#
#   0. dbc-recheck.sh: has Meteora changed DBC on mainnet since the suite passed? (read-only, public node;
#      SKIP_RECHECK=1 leaves it out)
#   1. a fresh solana-test-validator with DBC (the 0.2.2 bytecode dumped from mainnet), DAMM v2 and the two
#      accounts DBC's migration uses (cloned from mainnet), Metaplex Token Metadata; a local metadata
#      server for the token's uri, padded to URI_LEN characters (default 93, a Pinata gateway address) so
#      that step 2 has its real size;
#   2. scripts/deploy-program.sh: the plan (dry), then SEND=1: it builds with programs/build.sh, deploys
#      (the throwaway dev wallet is the upgrade authority), dumps the program back and compares the sha256,
#      and writes program.json (this run's own copy);
#   3. scripts/init-hunch.mjs: the plan, then SEND=1 STEP=initialize (the ticker is token.json's symbol);
#   4. launch.mjs: the plan, SEND=1 STEP=config, the plan, SEND=1 STEP=token (createPool, the creator
#      transfer to the budget PDA, the developer's buy when DEV_BUY_SOL is above 0, and adopt_curve: one
#      transaction);
#   5. init-hunch.mjs STEP=adopt, the fallback: it must find Hunch running and send nothing; and a second
#      STEP=token must be refused;
#   6. the crank: dry, one pass; then three copies with SEND=1 (A and B both at second 3 of every bar, to
#      show that duplicates only fail; C a backup at second 14, which should send nothing) and a pretend
#      crowd trading round trips, by the chain's clock until CRANK_SECONDS have passed and BOUNDARIES UTC
#      hour boundaries (default 1; 2 gives a buy in the first full hour and its diary line, the one that
#      names the ticker) plus 15 minutes;
#   7. a summary: what each crank did, the diary lines the boundary ticks wrote, the accounts afterwards.
#
# Run from WSL or Linux:  bash hunch/launch/rehearse-local.sh
#   HUNCH_TARGET=<folder>   where everything is written and built (default ~/hunch-target); the run is in
#                           $HUNCH_TARGET/launch-local unless REHEARSAL_DIR says otherwise
#   SO=<hunch.so>           deploy this binary instead of building (deploy-program.sh's local option)
#   TESTED_SHA256=<sha>     deploy-program.sh refuses a build with another sha256
#   CRANK_SECONDS=3600      chain seconds of cranking at least; BOUNDARIES=0 drops the hour-boundary rule
#   DEV_BUY_SOL=0.5         rehearse the developer's buy in step 2 (default: token.json's devBuySol);
#                           WRAP_FIRST=1 wraps it into the dev wallet's WSOL account before step 2 (needed
#                           for it to fit beside adopt_curve with a real-length uri)
#   LAUNCH_ONLY=1           stop after step 5
#   SOL_USD                 the SOL price for the curve (default 180)
#   RPC_PORT, FAUCET_PORT, GOSSIP_PORT, DYNAMIC_PORTS (a-b), META_PORT: the ports (defaults 18899, 19900,
#                           18000, 18001-18200, 18765); the validator also takes RPC_PORT + 1 for websockets
# Nothing in the Windows tree is written except by the tools themselves, which write their records into the
# run's folder on a local cluster (HUNCH_RECORDS, HUNCH_TOKEN_FILE, HUNCH_PROGRAM_FILE).
set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
here="$(cd "$(dirname "$0")" && pwd)"
crank="$here/../crank"
scripts="$here/../scripts"
target="${HUNCH_TARGET:-$HOME/hunch-target}"
W="${REHEARSAL_DIR:-$target/launch-local}"
M="${MAINNET_PROGRAMS:-$target/mainnet-programs}"
ACC="${MAINNET_ACCOUNTS:-$target/mainnet-accounts}"
DBC_SO="${DBC_SO:-$M/dbc-0.2.2.so}"
DAMM_SO="${DAMM_SO:-$M/damm_v2.so}"
MPL_SO="${MPL_SO:-$M/mpl_token_metadata.so}"
SECONDS_RUN="${CRANK_SECONDS:-3600}"
BOUNDARIES="${BOUNDARIES:-1}"
PORT="${RPC_PORT:-18899}"
FAUCET="${FAUCET_PORT:-19900}"
GOSSIP="${GOSSIP_PORT:-18000}"
DYNAMIC="${DYNAMIC_PORTS:-18001-18200}"
META_PORT="${META_PORT:-18765}"
URI_LEN="${URI_LEN:-93}"
DEV_BUY="${DEV_BUY_SOL:-$(node -e 'console.log(require(process.argv[1]).devBuySol ?? 0)' "$here/token.json")}"

rm -rf "$W"
mkdir -p "$W/logs"
step() { echo; echo "== $*"; }

if [ "${SKIP_RECHECK:-}" != "1" ]; then
  step "0. bash dbc-recheck.sh (read-only, public mainnet node)"
  HUNCH_TARGET="$target" bash "$here/dbc-recheck.sh" || { echo "DBC on mainnet is not the tested bytecode: stop here (see above)."; exit 1; }
fi

step "keys (throwaway, local only)"
node "$crank/test/make-throwaway.mjs" "$W/throwaway" dev mint program crankA crankB crankC trader | tee "$W/keys.txt"
pub() { grep "^$1 " "$W/keys.txt" | cut -d' ' -f2; }
PROGRAM_ID="$(pub program)"

step "1. validator: DBC $(sha256sum "$DBC_SO" | cut -c1-16)..., DAMM v2 $(sha256sum "$DAMM_SO" | cut -c1-16)..., RPC 127.0.0.1:$PORT"
solana-test-validator --reset --quiet --ledger "$W/ledger" --rpc-port "$PORT" --faucet-port "$FAUCET" --gossip-port "$GOSSIP" --dynamic-port-range "$DYNAMIC" \
  --limit-ledger-size 50000000 \
  --bpf-program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN "$DBC_SO" \
  --bpf-program cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG "$DAMM_SO" \
  --bpf-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s "$MPL_SO" \
  --account A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck "$ACC/damm_config_customizable.json" \
  --account FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM "$ACC/dbc_pool_authority.json" \
  > "$W/logs/validator.log" 2>&1 &
pids=($!)
node "$crank/test/serve-metadata.mjs" "$META_PORT" > "$W/logs/metadata.log" 2>&1 &
pids+=($!)
trap 'for p in "${pids[@]}"; do kill $p 2>/dev/null || true; done; wait 2>/dev/null || true' EXIT
RPC="http://127.0.0.1:$PORT"
for _ in $(seq 1 90); do solana -u "$RPC" cluster-version >/dev/null 2>&1 && break; sleep 1; done
solana -u "$RPC" airdrop 100 "$(pub dev)" >/dev/null
echo "dev wallet $(pub dev): $(solana -u "$RPC" balance "$(pub dev)")"

# the launch tool's settings for this run: the real token.json with a local uri (a fragment pads it to the
# real address's length; fetch leaves the fragment out) and the rehearsal's dev buy; program.json empty, for
# deploy-program.sh to fill
node -e '
const fs = require("fs");
const t = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const base = `http://127.0.0.1:${process.argv[3]}/metadata.json`;
const len = Number(process.argv[5]);
t.uri = base.length + 1 < len ? `${base}#${"x".repeat(len - base.length - 1)}` : base;
t.devBuySol = Number(process.argv[4]);
fs.writeFileSync(process.argv[2] + "/token.json", JSON.stringify(t, null, 2));
fs.writeFileSync(process.argv[2] + "/program.json", JSON.stringify({}, null, 2));
console.log(`token.json for this run: ${t.name} ($${t.symbol}), uri of ${t.uri.length} characters, devBuySol ${t.devBuySol}`);
' "$here/token.json" "$W" "$META_PORT" "$DEV_BUY" "$URI_LEN"

export CLUSTER=localnet RPC_URL="$RPC" SOL_USD="${SOL_USD:-180}" PRIORITY=50000
export KEYPAIR="$W/throwaway/dev.json" MINT_KEYPAIR="$W/throwaway/mint.json" PROGRAM_KEYPAIR="$W/throwaway/program.json"
export HUNCH_TOKEN_FILE="$W/token.json" HUNCH_PROGRAM_FILE="$W/program.json" HUNCH_RECORDS="$W" HUNCH_TARGET="$target"
cd "$scripts"
step "2. bash deploy-program.sh (plan)";               bash deploy-program.sh
step "2. SEND=1 bash deploy-program.sh";               SEND=1 bash deploy-program.sh
solana -u "$RPC" program show "$PROGRAM_ID" | sed -n '1,7p'
step "3. node init-hunch.mjs (plan)";                  node init-hunch.mjs
step "3. SEND=1 STEP=initialize node init-hunch.mjs";  SEND=1 STEP=initialize node init-hunch.mjs
cd "$here"
step "4. node launch.mjs (plan)";                      node launch.mjs
step "4. SEND=1 STEP=config node launch.mjs";          SEND=1 STEP=config node launch.mjs
if [ "${WRAP_FIRST:-}" = "1" ] && [ "$DEV_BUY" != "0" ]; then
  # a developer's buy with adopt_curve and a real-length uri may not fit in one transaction: the buy's SOL
  # wrapped into the dev wallet's WSOL account beforehand takes the wrapping out of step 2
  # (spl-token wrap counts the new account's rent in the amount it moves: wrap the buy plus the rent)
  WRAP="$(awk -v b="$DEV_BUY" -v r="$(solana rent 165 -u "$RPC" --lamports | grep -o '[0-9]*' | head -1)" 'BEGIN { printf "%.9f", b + r / 1e9 }')"
  step "4. spl-token wrap $WRAP (the developer's $DEV_BUY SOL buy plus the WSOL account's rent, wrapped beforehand)"
  spl-token wrap "$WRAP" "$KEYPAIR" --fee-payer "$KEYPAIR" -u "$RPC" | grep -v "^$"
fi
step "4. node launch.mjs (plan)";                      node launch.mjs
step "4. SEND=1 STEP=token node launch.mjs";           SEND=1 STEP=token node launch.mjs
cd "$scripts"
step "5. node init-hunch.mjs (plan): Hunch must already be running"; node init-hunch.mjs
step "5. SEND=1 STEP=adopt node init-hunch.mjs (the fallback: must send nothing)"; SEND=1 STEP=adopt node init-hunch.mjs && { echo "NOT REFUSED (wrong)"; exit 1; } || echo "(nothing sent, exit $?)"
cd "$here"
step "5. node launch.mjs after the launch (plan)";     node launch.mjs
step "5. SEND=1 STEP=token again (must refuse)";       SEND=1 STEP=token node launch.mjs && { echo "NOT REFUSED (wrong)"; exit 1; } || echo "(refused, exit $?)"
if [ "${LAUNCH_ONLY:-}" = "1" ]; then step "LAUNCH_ONLY=1: stopping before the crank"; exit 0; fi

cd "$crank"
step "6. crank, dry (the default), one pass";          PAYER="$(pub dev)" PROGRAM_ID="$PROGRAM_ID" node crank.mjs --local --once
# The hours are counted by the chain's clock (a loaded local validator's clock can run slower than this machine's).
UNTIL="$(node --input-type=module -e '
const { web3 } = await import(process.argv[1] + "/deps.mjs");
const c = await new web3.Connection(process.argv[2]).getAccountInfo(new web3.PublicKey("SysvarC1ock11111111111111111111111111111111"));
const now = Number(c.data.readBigInt64LE(32));
const n = Number(process.argv[4]);
const hour = n === 0 ? 0 : (Math.floor(now / 3600) + n) * 3600 + 900;
console.log(Math.max(now + Number(process.argv[3]), hour));
' "$crank" "$RPC_URL" "$SECONDS_RUN" "$BOUNDARIES")"
step "6. the cranks (SEND=1) and a pretend crowd until the chain's clock reads $UNTIL ($(date -u -d @$UNTIL +%H:%M:%S) UTC); logs in $W/logs"
RPC_URL="$RPC_URL" TRADER_KEYPAIR="$W/throwaway/trader.json" LAUNCHED="$W/launched.localnet.json" node test/trader.mjs --for 100000 > "$W/logs/trader.log" 2>&1 &
trader=$!
pids+=($trader)
cranks=()
for c in A B C; do
  from=3; jitter=0
  [ $c = C ] && from=14
  SEND=1 PROGRAM_ID="$PROGRAM_ID" CRANK_KEYPAIR="$W/throwaway/crank$c.json" TICK_FROM=$from TICK_JITTER=$jitter CRANK_LOG="$W/logs/crank$c.jsonl" \
    node crank.mjs --local --until "$UNTIL" > "$W/logs/crank$c.log" 2>&1 &
  cranks+=($!)
  pids+=($!)
done
wait "${cranks[@]}" || true
kill $trader 2>/dev/null || true
sleep 1
step "7. summary"
node test/summary.mjs "$W/logs" "$PROGRAM_ID" "$RPC_URL"
