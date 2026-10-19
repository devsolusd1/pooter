#!/bin/bash
# The crank through the graduation, end to end on a LOCAL validator (never devnet or mainnet), with
# Meteora DBC 0.2.2's, DAMM v2's and Metaplex's mainnet bytecode, the two mainnet accounts DBC's
# migration needs (the DAMM v2 config of the Customizable migration, and DBC's pool authority with its
# balance), the Hunch program, the real token.json (with a fixed SOL price) and throwaway keys.
# Based on hunch/launch/rehearse-local.sh (left as it is); what it adds:
#   - the cranks run through the graduation: the curve completes (throwaway buyers, after the opening
#     fee), Meteora's migration into DAMM v2 is sent the way its keeper would (test/migrate.mjs: DBC's
#     migration_damm_v2, paid by a throwaway key, no Meteora key), and the cranks must withdraw_surplus
#     once, adopt_pool once, tick on DAMM v2 every bar, claim_pool_fees and try the hourly buy;
#   - the crowd (test/trader.mjs) moves to the DAMM v2 pool once DBC has migrated;
#   - test/audit.mjs reads back from the chain every transaction that touched Hunch's State.
# Two modes:
#   MODE=live  a crank started BEFORE the launch (it must wait), then two more at once: P and A tick at
#              second 3 of each bar, B (set up as a backup) at second 14. The curve is bought out at once
#              and migrated at once (a prompt keeper), with the cranks running. Ends 15 minutes after the
#              first UTC hour boundary in the pool phase (SHORT=1: 11 minutes after the adoption).
#   MODE=late  one crank on the curve; the curve is bought out from minute COMPLETE_MINUTE (default 45)
#              so that the next boundary tick turns Hunch to "graduating"; every crank is stopped right
#              after that tick lands (before it can withdraw the surplus), the migration is sent while
#              no crank runs (a slow keeper), then two cranks start at once: they must catch up.
#              CURVE_TICKS (default 2): landed curve ticks before the buyout may start (both modes).
#              Ends LATE_MINUTES (default 25) after they start, or with HOUR=1 15 minutes after the
#              next boundary.
#
# Run from WSL or Linux (a work copy of hunch/ whose crank/ is the one being tested):
#   MODE=live bash hunch/crank/test/graduation-e2e.sh
#   MODE=late RPC_PORT=10190 FAUCET_PORT=10192 GOSSIP_PORT=10193 DYNAMIC_PORTS=10150-10189 META_PORT=10197 bash hunch/crank/test/graduation-e2e.sh
# Settings (defaults): HUNCH_SO (~/hunch-target/deploy/hunch.so), RPC_PORT 8920 (its websocket takes the
# next port), FAUCET_PORT 9920, GOSSIP_PORT 10050, DYNAMIC_PORTS 10100-10149, META_PORT 10196,
# SOL_USD 104.4 (about 113 SOL in the curve at graduation), E2E_DIR ($HUNCH_TARGET/e2e/$MODE), LEDGER ($HUNCH_TARGET/e2e-ledger/$MODE),
# MODULES_FROM (a folder whose node_modules has the pinned Solana packages).
set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
here="$(cd "$(dirname "$0")" && pwd)"
crank="$here/.."
launch="$here/../../launch"
scripts="$here/../../scripts"
target="${HUNCH_TARGET:-$HOME/hunch-target}"
MODE="${MODE:-live}"
[ "$MODE" = live ] || [ "$MODE" = late ] || { echo "MODE is live or late"; exit 1; }
W="${E2E_DIR:-$target/e2e/$MODE}"
LEDGER="${LEDGER:-$target/e2e-ledger/$MODE}"
DBC_SO="${DBC_SO:-$target/mainnet-programs/dbc-0.2.2.so}"
DAMM_SO="${DAMM_SO:-$target/mainnet-programs/damm_v2.so}"
MPL_SO="${MPL_SO:-$target/mainnet-programs/mpl_token_metadata.so}"
ACCOUNTS="${MAINNET_ACCOUNTS:-$target/mainnet-accounts}"
HUNCH_SO="${HUNCH_SO:-$target/deploy/hunch.so}"
PORT="${RPC_PORT:-8920}"
META_PORT="${META_PORT:-10196}"
RPC="http://127.0.0.1:$PORT"

rm -rf "$W" "$LEDGER"
mkdir -p "$W/logs" "$(dirname "$LEDGER")"
echo "== $MODE: keys (throwaway, local only)"
node "$crank/test/make-throwaway.mjs" "$W/throwaway" dev mint program crankP crankA crankB crankL1 crankL2 trader keeper buyer1 buyer2 buyer3 | tee "$W/keys.txt"
pub() { grep "^$1 " "$W/keys.txt" | cut -d' ' -f2; }
PROGRAM_ID="$(pub program)"
echo "== validator on $RPC: DBC $(sha256sum "$DBC_SO" | cut -c1-16)..., DAMM v2 $(sha256sum "$DAMM_SO" | cut -c1-16)..., Hunch $(stat -c %s "$HUNCH_SO") bytes ($(sha256sum "$HUNCH_SO" | cut -c1-16)...)"
solana-test-validator --reset --quiet --ledger "$LEDGER" --rpc-port $PORT --faucet-port "${FAUCET_PORT:-9920}" --gossip-port "${GOSSIP_PORT:-10050}" --dynamic-port-range "${DYNAMIC_PORTS:-10100-10149}" \
  --bpf-program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN "$DBC_SO" \
  --bpf-program cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG "$DAMM_SO" \
  --bpf-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s "$MPL_SO" \
  --account A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck "$ACCOUNTS/damm_config_customizable.json" \
  --account FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM "$ACCOUNTS/dbc_pool_authority.json" \
  --upgradeable-program "$PROGRAM_ID" "$HUNCH_SO" "$(pub dev)" \
  --limit-ledger-size 50000000 \
  > "$W/logs/validator.log" 2>&1 &
# (--limit-ledger-size: the test validator's default keeps about 10,000 shreds, a few minutes, and the
# audit at the end reads every transaction back from the start)
pids=($!)
node "$crank/test/serve-metadata.mjs" $META_PORT > "$W/logs/metadata.log" 2>&1 &
pids+=($!)
cranks=()
trap 'for p in "${cranks[@]}" "${pids[@]}"; do kill $p 2>/dev/null || true; done; wait 2>/dev/null || true' EXIT
for _ in $(seq 1 90); do solana -u $RPC cluster-version >/dev/null 2>&1 && break; sleep 1; done
solana -u $RPC airdrop 100 "$(pub dev)" >/dev/null
solana -u $RPC program show "$PROGRAM_ID" | sed -n '1,4p'

node -e '
const fs = require("fs");
const t = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
t.uri = `http://127.0.0.1:${process.argv[3]}/metadata.json`;
fs.writeFileSync(process.argv[2] + "/token.json", JSON.stringify(t, null, 2));
fs.writeFileSync(process.argv[2] + "/program.json", JSON.stringify({ localnet: process.argv[4] }, null, 2));
' "$launch/token.json" "$W" $META_PORT "$PROGRAM_ID"

export CLUSTER=localnet RPC_URL="$RPC" SOL_USD="${SOL_USD:-104.4}" PRIORITY=50000
export KEYPAIR="$W/throwaway/dev.json" MINT_KEYPAIR="$W/throwaway/mint.json"
export HUNCH_TOKEN_FILE="$W/token.json" HUNCH_PROGRAM_FILE="$W/program.json" HUNCH_RECORDS="$W"
step() { echo; echo "== $(date -u +%H:%M:%S) $*"; }
chain_now() { node --input-type=module -e '
const { web3 } = await import(process.argv[1] + "/deps.mjs");
const c = await new web3.Connection(process.argv[2], "confirmed").getAccountInfo(new web3.PublicKey("SysvarC1ock11111111111111111111111111111111"));
console.log(Number(c.data.readBigInt64LE(32)));' "$crank" "$RPC"; }
state() { node --input-type=module -e '
const { web3 } = await import(process.argv[1] + "/deps.mjs");
const h = await import(process.argv[1] + "/hunch-program.mjs");
const i = await new web3.Connection(process.argv[2], "confirmed").getAccountInfo(h.addresses(process.argv[3]).state);
const s = i ? h.decodeState(i.data) : null;
console.log(s ? `${s.phase} ${s.ticks} ${s.graduation?.adoptTs ?? 0}` : "none 0 0");' "$crank" "$RPC" "$PROGRAM_ID"; }
run_crank() { # name tick_from
  SEND=1 PROGRAM_ID="$PROGRAM_ID" CRANK_KEYPAIR="$W/throwaway/crank$1.json" TICK_FROM=$2 TICK_JITTER=0 CRANK_LOG="$W/logs/crank$1.jsonl" \
    node "$crank/crank.mjs" --local --for 100000 > "$W/logs/crank$1.log" 2>&1 &
  cranks+=($!)
  eval "crank_$1=$!"
}

if [ $MODE = live ]; then
  step "crank P started BEFORE the launch (nothing is initialized yet: it must wait)"
  run_crank P 3
  sleep 8
fi
step "launch: init-hunch.mjs STEP=initialize, launch.mjs STEP=config and STEP=token, init-hunch.mjs STEP=adopt"
(cd "$scripts" && SEND=1 STEP=initialize node init-hunch.mjs > "$W/logs/init.log" 2>&1) || { tail -20 "$W/logs/init.log"; exit 1; }
(cd "$launch" && SEND=1 STEP=config node launch.mjs > "$W/logs/config.log" 2>&1) || { tail -20 "$W/logs/config.log"; exit 1; }
(cd "$launch" && SEND=1 STEP=token node launch.mjs > "$W/logs/token.log" 2>&1) || { tail -20 "$W/logs/token.log"; exit 1; }
(cd "$scripts" && SEND=1 STEP=adopt node init-hunch.mjs > "$W/logs/adopt.log" 2>&1) || { tail -20 "$W/logs/adopt.log"; exit 1; }
grep -h -i "graduat\|threshold\|migration" "$W/logs/config.log" | head -5 || true
L="$W/launched.localnet.json"
echo "pool $(node -e 'console.log(require(process.argv[1]).pool)' "$L"), Hunch $(state)"

step "the crowd (DBC, then DAMM v2 once migrated)"
RPC_URL="$RPC" TRADER_KEYPAIR="$W/throwaway/trader.json" LAUNCHED="$L" node "$crank/test/trader.mjs" --for 100000 > "$W/logs/trader.log" 2>&1 &
pids+=($!)
if [ $MODE = live ]; then
  step "cranks A and B started at once (A at second 3 of each bar like P; B a backup at second 14)"
  run_crank A 3
  run_crank B 14
else
  step "crank A on the curve"
  run_crank A 3
fi

step "waiting for ${CURVE_TICKS:-2} landed tick(s) on the curve"
until [ "$(state | cut -d' ' -f2)" -ge "${CURVE_TICKS:-2}" ]; do sleep 5; done
echo "Hunch $(state)"

if [ $MODE = late ]; then
  minute="${COMPLETE_MINUTE:-45}"
  step "waiting for minute $minute of the hour (chain clock) before buying the curve out"
  until [ $(( $(chain_now) % 3600 )) -ge $((minute * 60)) ]; do sleep 10; done
fi
step "buying the curve out (throwaway buyers)"
RPC_URL="$RPC" LAUNCHED="$L" node "$crank/test/buyout.mjs" "$W/throwaway/buyer1.json" "$W/throwaway/buyer2.json" "$W/throwaway/buyer3.json" | tee "$W/logs/buyout.log"

if [ $MODE = live ]; then
  step "the migration at once (a prompt keeper), with the cranks running"
  RPC_URL="$RPC" LAUNCHED="$L" KEEPER_KEYPAIR="$W/throwaway/keeper.json" node "$crank/test/migrate.mjs" | tee "$W/logs/migration.json"
  step "waiting for a crank to adopt the DAMM v2 pool"
  until [ "$(state | cut -d' ' -f1)" = 3 ]; do sleep 5; done
  adopted="$(state | cut -d' ' -f3)"
  UNTIL=$(( (adopted / 3600 + 1) * 3600 + 900 ))
  # SHORT=1: a smoke run, ended 11 minutes after the adoption (one or two ticks on DAMM v2)
  [ "${SHORT:-0}" = 1 ] && UNTIL=$(( adopted + 660 ))
else
  step "waiting for the boundary tick that turns Hunch to graduating, then stopping every crank at once"
  until [ "$(state | cut -d' ' -f1)" = 2 ]; do sleep 1; done
  for p in "${cranks[@]}"; do kill $p 2>/dev/null || true; done
  cranks=()
  echo "cranks stopped at chain time $(chain_now); Hunch $(state)"
  sleep "${KEEPER_DELAY:-60}"
  step "the migration while no crank runs (a slow keeper)"
  RPC_URL="$RPC" LAUNCHED="$L" KEEPER_KEYPAIR="$W/throwaway/keeper.json" node "$crank/test/migrate.mjs" | tee "$W/logs/migration.json"
  sleep 30
  step "two cranks started at once after the migration (L1, L2): they must catch up"
  run_crank L1 3
  run_crank L2 3
  now=$(chain_now)
  if [ "${HOUR:-0}" = 1 ]; then UNTIL=$(( (now / 3600 + 1) * 3600 + 900 )); else UNTIL=$(( now + ${LATE_MINUTES:-25} * 60 )); fi
fi
step "running until the chain's clock reads $UNTIL ($(date -u -d @$UNTIL +%H:%M:%S) UTC)"
until [ "$(chain_now)" -ge "$UNTIL" ]; do sleep 20; done
for p in "${cranks[@]}"; do kill $p 2>/dev/null || true; done
cranks=()
sleep 2
step "audit (read back from the chain)"
node "$crank/test/audit.mjs" "$RPC" "$PROGRAM_ID" "$W/logs/migration.json" | tee "$W/logs/audit.txt"
step "what each crank logged"
node "$crank/test/summary.mjs" "$W/logs" "$PROGRAM_ID" "$RPC" | tee "$W/logs/summary.txt"
