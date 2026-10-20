#!/bin/bash
# A local rehearsal of the developer's four tools, on a solana-test-validator that holds the LIVE program's
# accounts: nothing is sent to devnet or mainnet, and no real key is used.
#
#   bash rehearse-withdraw.sh                       # TESTED_SHA256=<sha> to name the tested build (default:
#                                                   # the sha256 of $HUNCH_TARGET/deploy/hunch.so, test-v1.sh's)
#
# 1. The live accounts are cloned read-only from mainnet through the public RPC (programs/tests/clone-live.mjs:
#    the program's state, model, tape, open call, diary, brain book, the budget's WSOL and coin accounts, the
#    DBC pool, its config, its vaults, the mint, DBC's pool authority). Three changes, all local and said here:
#    the DEPLOYED build is loaded with a THROWAWAY upgrade authority (the developer's key is never used), the
#    DBC config's fee claimer is set to that same throwaway key, so the partner-fee claim can run, and every
#    account is topped up to the test validator's rent (6,960 lamports a byte, against mainnet's 5,080; a
#    wrapped-SOL account keeps its amount): see rehearse-patch-account.mjs.
# 2. A validator inside a private network namespace (unshare -n: only its own loopback, no route out, so
#    nothing can reach devnet or mainnet and no port is bound on the host; its RPC is 127.0.0.1:8970 in there,
#    and the dynamic ports the validator insists on, at least 25, are the namespace's own), with Meteora DBC's
#    0.2.2 mainnet bytecode, SPL Memo, the deployed Hunch build (face57dd..., ~/hunch-target/final/hunch.so)
#    as an upgradeable program at the live address, and those accounts. The throwaway wallet gets 3 SOL.
# 3. The tools, each dry first, in the order the developer would use them:
#    withdraw-budget.mjs against the deployed build (refused: it has no withdraw_budget);
#    upgrade-program.sh (dry without TESTED_SHA256, dry, SEND: extend, buffer, check, upgrade, check);
#    withdraw-budget.mjs (dry; AMOUNT=0.5 SEND; dry; SEND for the rest; dry once more: nothing left);
#    rehearse-buy.mjs (the developer's buy by hand, here a DBC buy from the throwaway wallet);
#    burn.mjs (dry, AMOUNT=ALL SEND); claim-dev-fees.mjs (dry, SEND).
# The tools read this rehearsal's own settings file (HUNCH_ENV_FILE), program.json and launched.localnet.json,
# never hunch/launch/.env. Everything lands in $W (default ~/hunch-target/withdraw/rehearsal), each step's log
# in $W/logs, and the accounts after it all in $W/after (for a page check against them).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
hunch="$here/.."
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
export HUNCH_TARGET="${HUNCH_TARGET:-$HOME/hunch-target/withdraw}"
W="${W:-$HUNCH_TARGET/rehearsal}"
PORT=8970 FAUCET=8972 GOSSIP=8973 DYNAMIC=9001-9030   # all inside the private network namespace
OLD_SO="${OLD_HUNCH_SO:-$HOME/hunch-target/final/hunch.so}"
DBC_SO="${DBC_SO:-$HOME/hunch-target/mainnet-programs/dbc-0.2.2.so}"
MEMO_SO="${MEMO_SO:-$HOME/hunch-target/mainnet-programs/memo.so}"
step() { echo; echo "######## $*"; }
if [ -z "${IN_NETNS:-}" ]; then
  rm -rf "$W"; mkdir -p "$W/logs" "$W/accounts"
  step "1. clone the live accounts (public RPC, read-only)"
  node "$hunch/programs/tests/clone-live.mjs" "$W/live" | tee "$W/logs/clone.log"
  # everything after the clone runs in a private network namespace: loopback only
  exec unshare --user --map-root-user --net env IN_NETNS=1 W="$W" HUNCH_TARGET="$HUNCH_TARGET" TESTED_SHA256="${TESTED_SHA256:-}" bash "$0"
fi
ip link set lo up
if curl -s -m 3 https://api.mainnet-beta.solana.com >/dev/null 2>&1; then echo "REFUSED: the namespace can reach the internet"; exit 1; fi
echo "inside a private network namespace: loopback only, mainnet unreachable"
program=$(node -e 'console.log(require(process.argv[1]).program)' "$W/live/index.json")
solana-keygen new --no-bip39-passphrase --silent -o "$W/authority.json" >/dev/null
auth=$(solana-keygen pubkey "$W/authority.json")
echo "throwaway upgrade authority, fee claimer and wallet: $auth"
args=()
for f in "$W/live"/*.json; do
  role=$(basename "$f" .json)
  case "$role" in index|programdata|clock) continue ;; esac
  node "$here/rehearse-patch-account.mjs" "$f" "$W/accounts/$role.json" "$auth" >> "$W/logs/patched.log"
  f="$W/accounts/$role.json"
  args+=(--account "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pubkey)' "$f")" "$f")
done
echo "accounts patched for local rent (and the DBC config's fee claimer): $W/logs/patched.log"

step "2. a local validator (private network namespace, RPC 127.0.0.1:$PORT) with the deployed build at $program"
echo "deployed build: $OLD_SO, sha256 $(sha256sum "$OLD_SO" | cut -c1-64)"
solana-test-validator --reset --quiet --ledger "$W/ledger" --rpc-port "$PORT" --faucet-port "$FAUCET" --gossip-port "$GOSSIP" --dynamic-port-range "$DYNAMIC" \
  --limit-ledger-size 50000000 \
  --bpf-program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN "$DBC_SO" \
  --bpf-program MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr "$MEMO_SO" \
  --upgradeable-program "$program" "$OLD_SO" "$auth" \
  "${args[@]}" > "$W/logs/validator.log" 2>&1 &
vpid=$!
trap 'kill $vpid 2>/dev/null || true; wait 2>/dev/null || true' EXIT
RPC="http://127.0.0.1:$PORT"
for _ in $(seq 1 120); do solana -u "$RPC" cluster-version >/dev/null 2>&1 && break; sleep 1; done
solana -u "$RPC" airdrop 3 "$auth" >/dev/null
echo "validator up; the throwaway wallet holds $(solana -u "$RPC" balance "$auth")"
solana -u "$RPC" program show "$program" | sed -n '1,8p'
printf 'CLUSTER=localnet\nRPC_URL=%s\nKEYPAIR=%s\nPRIORITY=1000\n' "$RPC" "$W/authority.json" > "$W/rehearsal.settings"
printf '{\n  "localnet": "%s"\n}\n' "$program" > "$W/program.json"
node -e 'const i=require(process.argv[1]); require("fs").writeFileSync(process.argv[2], JSON.stringify({cluster:"localnet", mint:i.accounts.mint, pool:i.accounts.pool, config:i.accounts.config, programId:i.program}, null, 2)+"\n")' "$W/live/index.json" "$W/launched.localnet.json"
export HUNCH_ENV_FILE="$W/rehearsal.settings" HUNCH_PROGRAM_FILE="$W/program.json" HUNCH_RECORDS="$W"
cd "$here"
run() { local name="$1"; shift; echo "\$ $*"; "$@" 2>&1 | tee "$W/logs/$name.log"; return "${PIPESTATUS[0]}"; }

step "3a. withdraw-budget.mjs against the deployed build (it has no withdraw_budget: refused in simulation)"
run withdraw-before-upgrade node withdraw-budget.mjs || echo "(exit $?: as expected)"

step "3b. upgrade-program.sh, dry, without TESTED_SHA256, then with it, then SEND=1"
run upgrade-dry-1 bash upgrade-program.sh || true
tested="${TESTED_SHA256:-$(sha256sum "$HUNCH_TARGET/deploy/hunch.so" | cut -c1-64)}"
echo "TESTED_SHA256=$tested"
TESTED_SHA256=$tested run upgrade-dry-2 bash upgrade-program.sh
SEND=1 TESTED_SHA256=$tested run upgrade-send bash upgrade-program.sh
echo "buffers left: $(solana -u "$RPC" program show --buffers --keypair "$W/authority.json" 2>&1 | grep -c '^ *[1-9A-HJ-NP-Za-km-z]\{32,44\} ' || true)"

step "3c. withdraw-budget.mjs: dry, AMOUNT=0.5 SEND=1, dry, SEND=1 (the rest), dry again"
run withdraw-dry-1 node withdraw-budget.mjs
AMOUNT=0.5 SEND=1 run withdraw-send-half node withdraw-budget.mjs
run withdraw-dry-2 node withdraw-budget.mjs
SEND=1 run withdraw-send-rest node withdraw-budget.mjs
run withdraw-dry-3 node withdraw-budget.mjs || echo "(exit $?: nothing left to withdraw, as expected)"

step "3d. the developer's buy by hand (here a 1 SOL DBC buy from the throwaway wallet), then burn.mjs"
LAMPORTS=1000000000 CLUSTER=localnet RPC_URL="$RPC" KEYPAIR="$W/authority.json" run buy node rehearse-buy.mjs
AMOUNT=1000 run burn-dry node burn.mjs
AMOUNT=ALL SEND=1 run burn-send node burn.mjs
AMOUNT=ALL run burn-after node burn.mjs || echo "(exit $?: nothing left to burn, as expected)"

step "3e. claim-dev-fees.mjs, dry, then SEND=1"
run claim-dry node claim-dev-fees.mjs
SEND=1 run claim-send node claim-dev-fees.mjs || true

step "3f. the accounts the site reads, after it all (for a page check against them)"
mkdir -p "$W/after"
for role in state signal diary model book tape pool budget_wsol budget_hunch mint programdata config; do
  addr=$(node -e 'console.log(require(process.argv[1]).accounts[process.argv[2]] ?? "")' "$W/live/index.json" "$role")
  [ -n "$addr" ] && solana account "$addr" -u "$RPC" --output json-compact > "$W/after/$role.json"
done
echo "written: $(ls "$W/after" | tr '\n' ' ')"
echo; echo "rehearsal done; logs in $W/logs"
