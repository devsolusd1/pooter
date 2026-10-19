#!/bin/bash
# Two checks on a LOCAL validator (RPC 8960, faucet 9960, gossip 10070, dynamic 10500-10600; never a real
# cluster), with throwaway keys:
#   1. scripts/deploy-program.sh: the plan, then SEND=1 (a real loader-v3 deploy with --max-len = the
#      binary's size and the throwaway deployer as upgrade authority), the dump-back comparison, and a
#      second SEND=1 that must refuse (the program exists);
#   2. launch/test/devbuy-probe.mjs: the developer's buy in the pool-creating transaction, built as launch.mjs
#      builds it, in both orders with the first-swap flag (3.75%) and once without it (50%).
# Run from WSL:  bash hunch/launch/test/deploy-and-devbuy-local.sh      (SO=<hunch.so> to pick the binary,
# default ~/hunch-target/final/hunch.so). Writes to $HUNCH_TARGET/eng-site/deploy-local.
# The end-to-end launch with and without the buy is test/step2-devbuy-local.sh (same ports: not both at once).
set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
here="$(cd "$(dirname "$0")" && pwd)"
hunch="$here/../.."
target="${HUNCH_TARGET:-$HOME/hunch-target}"
W="$target/eng-site/deploy-local"
SO="${SO:-$target/final/hunch.so}"
rm -rf "$W"; mkdir -p "$W"
node "$hunch/crank/test/make-throwaway.mjs" "$W/throwaway" deployer program > "$W/keys.txt"
solana-test-validator --reset --quiet --ledger "$W/ledger" --rpc-port 8960 --faucet-port 9960 --gossip-port 10070 --dynamic-port-range 10500-10600 \
  --bpf-program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN "$target/mainnet-programs/dbc-0.2.2.so" \
  --bpf-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s "$target/mainnet-programs/mpl_token_metadata.so" \
  > "$W/validator.log" 2>&1 &
v=$!
trap 'kill $v 2>/dev/null; wait $v 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do solana -u http://127.0.0.1:8960 cluster-version >/dev/null 2>&1 && break; sleep 1; done
solana -u http://127.0.0.1:8960 airdrop 10 "$(grep '^deployer ' "$W/keys.txt" | cut -d' ' -f2)" >/dev/null

# a copy of program.json in which the deploy may record the local address (the real one is not touched)
echo "{}" > "$W/program.json"
export HUNCH_PROGRAM_FILE="$W/program.json" CLUSTER=localnet RPC_URL=http://127.0.0.1:8960 KEYPAIR="$W/throwaway/deployer.json" PROGRAM_KEYPAIR="$W/throwaway/program.json" SO PRIORITY=20000
echo "== deploy-program.sh (plan)"
bash "$hunch/scripts/deploy-program.sh"
echo; echo "== SEND=1 deploy-program.sh"
SEND=1 bash "$hunch/scripts/deploy-program.sh"
echo; echo "== SEND=1 deploy-program.sh again (must refuse)"
SEND=1 bash "$hunch/scripts/deploy-program.sh" && echo "NOT REFUSED (wrong)" || echo "(refused, as it should)"
echo; echo "== the deployer's balance after: $(solana balance "$(grep '^deployer ' "$W/keys.txt" | cut -d' ' -f2)" -u http://127.0.0.1:8960) of 10 SOL"

echo; echo "== dev buy probe"
RPC_URL=http://127.0.0.1:8960 node "$here/devbuy-probe.mjs" 0.5
