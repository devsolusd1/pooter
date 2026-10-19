#!/bin/bash
# Step 2 with and without the developer's buy, on a LOCAL validator (never devnet or mainnet), with Meteora
# DBC's 0.2.2 mainnet bytecode, Metaplex's, and two copies of the Hunch program (one program id per case;
# initialize runs once per program), throwaway keys made for the run, the real tools run as on launch day:
#
#   A. devBuySol 0.5: init-hunch.mjs (plan, initialize with the ticker HUNCH), launch.mjs (plan, config, plan,
#      token: createPool, the creator transfer to the budget PDA, the developer's buy and adopt_curve in one
#      transaction), init-hunch.mjs STEP=adopt (the fallback: it must find Hunch running and send nothing);
#      verify-step2.mjs then reads the chain: the config's flag is 1, the budget PDA
#      is the creator, the pool's fee counters hold exactly 3.75% of the buy, the developer holds the coin
#      and no WSOL account, Hunch is in the curve phase with the ticker HUNCH.
#   B. devBuySol 0: the same commands; the flag is 0 and nothing was swapped.
#   Refusals, each checked: a lowercase symbol (init-hunch.mjs sends nothing), STEP=buy, a second STEP=token,
#   and a token.json whose symbol is not the stored ticker (launch.mjs will not send step 2).
#
# Run from WSL:  bash hunch/launch/test/step2-devbuy-local.sh
#   HUNCH_SO=<hunch.so>   the program (default ~/hunch-target/final/hunch.so)
# Ports: RPC 8960, faucet 9960, gossip 10070, dynamic 10500-10600, the metadata server 4639.
# Everything it writes goes to $HUNCH_TARGET/eng-site/step2-local (default ~/hunch-target/eng-site/step2-local).
set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
here="$(cd "$(dirname "$0")" && pwd)"
launch="$here/.."
scripts="$here/../../scripts"
crank="$here/../../crank"
target="${HUNCH_TARGET:-$HOME/hunch-target}"
W="$target/eng-site/step2-local"
HUNCH_SO="${HUNCH_SO:-$target/final/hunch.so}"
DBC_SO="${DBC_SO:-$target/mainnet-programs/dbc-0.2.2.so}"
MPL_SO="${MPL_SO:-$target/mainnet-programs/mpl_token_metadata.so}"
RPC=http://127.0.0.1:8960
META_PORT=4639

rm -rf "$W"
mkdir -p "$W/logs"
node "$crank/test/make-throwaway.mjs" "$W/throwaway" dev mintA mintB progA progB > "$W/keys.txt"
pub() { grep "^$1 " "$W/keys.txt" | cut -d' ' -f2; }
echo "== validator: DBC $(sha256sum "$DBC_SO" | cut -c1-16)..., Hunch $(stat -c %s "$HUNCH_SO") bytes ($(sha256sum "$HUNCH_SO" | cut -c1-16)...) at $(pub progA) and $(pub progB)"
solana-test-validator --reset --quiet --ledger "$W/ledger" --rpc-port 8960 --faucet-port 9960 --gossip-port 10070 --dynamic-port-range 10500-10600 \
  --bpf-program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN "$DBC_SO" \
  --bpf-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s "$MPL_SO" \
  --upgradeable-program "$(pub progA)" "$HUNCH_SO" "$(pub dev)" \
  --upgradeable-program "$(pub progB)" "$HUNCH_SO" "$(pub dev)" \
  > "$W/logs/validator.log" 2>&1 &
pids=($!)
node "$crank/test/serve-metadata.mjs" $META_PORT > "$W/logs/metadata.log" 2>&1 &
pids+=($!)
trap 'for p in "${pids[@]}"; do kill $p 2>/dev/null || true; done; wait 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do solana -u $RPC cluster-version >/dev/null 2>&1 && break; sleep 1; done
solana -u $RPC airdrop 100 "$(pub dev)" >/dev/null

fails=0
step() { echo; echo "== $*"; }
must_refuse() { local what="$1"; shift; if "$@" > "$W/logs/refusal.log" 2>&1; then echo "NOT REFUSED (wrong): $what"; cat "$W/logs/refusal.log"; fails=$((fails + 1)); else echo "refused, as it should: $what"; grep -m2 -E "REFUSED|NOT READY|BAD_TICKER|not a ticker" "$W/logs/refusal.log" | sed 's/^/   /' || true; fi; }
settings() { # <folder> <program> <devBuySol> [symbol]
  mkdir -p "$1"
  node -e '
const fs = require("fs");
const t = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
t.uri = `http://127.0.0.1:${process.argv[3]}/metadata.json`;
t.devBuySol = Number(process.argv[5]);
if (process.argv[6]) t.symbol = process.argv[6];
fs.writeFileSync(process.argv[2] + "/token.json", JSON.stringify(t, null, 2));
fs.writeFileSync(process.argv[2] + "/program.json", JSON.stringify({ localnet: process.argv[4] }, null, 2));
' "$launch/token.json" "$1" $META_PORT "$2" "$3" "${4:-}"
}

run_case() { # <name> <program key name> <mint key name> <devBuySol>
  local C="$W/$1"
  settings "$C" "$(pub $2)" "$4"
  export CLUSTER=localnet RPC_URL=$RPC SOL_USD=180 PRIORITY=50000 KEYPAIR="$W/throwaway/dev.json" MINT_KEYPAIR="$W/throwaway/$3.json"
  export HUNCH_TOKEN_FILE="$C/token.json" HUNCH_PROGRAM_FILE="$C/program.json" HUNCH_RECORDS="$C"
  if [ "$1" = A ]; then
    settings "$C/lower" "$(pub $2)" "$4" hunch
    step "case $1: a lowercase symbol: init-hunch.mjs must send nothing"
    must_refuse "SEND=1 STEP=initialize with the symbol \"hunch\"" env HUNCH_TOKEN_FILE="$C/lower/token.json" SEND=1 STEP=initialize node "$scripts/init-hunch.mjs"
    if solana -u $RPC account "$(solana find-program-derived-address "$(pub $2)" string:state)" > /dev/null 2>&1; then
      echo "   A STATE ACCOUNT EXISTS (wrong)"; fails=$((fails + 1))
    else echo "   no state account was made"; fi
  fi
  step "case $1 (devBuySol $4): init-hunch.mjs (plan)";            (cd "$scripts" && node init-hunch.mjs)
  step "case $1: SEND=1 STEP=initialize node init-hunch.mjs";      (cd "$scripts" && SEND=1 STEP=initialize node init-hunch.mjs)
  step "case $1: launch.mjs (plan)";                               (cd "$launch" && node launch.mjs)
  step "case $1: SEND=1 STEP=config node launch.mjs";              (cd "$launch" && SEND=1 STEP=config node launch.mjs)
  step "case $1: launch.mjs (plan of step 2)";                     (cd "$launch" && node launch.mjs)
  if [ "$1" = B ]; then
    settings "$C/other" "$(pub $2)" "$4" HOURHOG
    step "case $1: a token.json whose symbol is not the stored ticker: launch.mjs must not send step 2"
    must_refuse "SEND=1 STEP=token with the symbol HOURHOG" env HUNCH_TOKEN_FILE="$C/other/token.json" SEND=1 STEP=token node "$launch/launch.mjs"
    grep -q "initialized with the ticker HUNCH, but token.json's symbol is \"HOURHOG\"" "$W/logs/refusal.log" && echo "   the reason given: the stored ticker HUNCH is not the symbol HOURHOG" \
      || { echo "   THE TICKER WAS NOT GIVEN AS A REASON (wrong)"; fails=$((fails + 1)); }
  fi
  step "case $1: SEND=1 STEP=token node launch.mjs";               (cd "$launch" && SEND=1 STEP=token node launch.mjs)
  step "case $1: init-hunch.mjs (plan)";                           (cd "$scripts" && node init-hunch.mjs)
  # step 2 adopts the pool in its own transaction (launch.mjs, 2026-10-16 night): STEP=adopt has nothing to do
  step "case $1: SEND=1 STEP=adopt node init-hunch.mjs (step 2 adopted the pool already: must send nothing)"
  must_refuse "SEND=1 STEP=adopt after step 2" bash -c "cd '$scripts' && SEND=1 STEP=adopt node init-hunch.mjs"
  step "case $1: the refusals after the launch"
  must_refuse "SEND=1 STEP=buy" bash -c "cd '$launch' && SEND=1 STEP=buy node launch.mjs"
  must_refuse "SEND=1 STEP=token again" bash -c "cd '$launch' && SEND=1 STEP=token node launch.mjs"
  step "case $1: what the chain holds"
  RPC_URL=$RPC node "$here/verify-step2.mjs" "$C" "$C/token.json" "$C/program.json" || fails=$((fails + 1))
}

run_case A progA mintA 0.5
run_case B progB mintB 0

echo
if [ $fails -eq 0 ]; then echo "step2-devbuy-local: everything as expected"; else echo "step2-devbuy-local: $fails FAILED"; exit 1; fi
