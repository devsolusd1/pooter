#!/bin/bash
# STAGE 1 (kept as the record): K1/K3 against the stage-1 proof program (instructions init = 0 and
# buy_and_burn = 1 with a bump, slice and min_out). The stage-2 program in hunch/ replaced that interface, so
# the K1 half of tests/k1k3.mjs no longer applies to the current build; test-v1.sh covers K1 with real DBC
# swaps in LiteSVM. The K3 half (createPool + transferPoolCreator in one transaction) is unchanged.
# Kill tests K1 and K3 for Hunch against Meteora DBC's real mainnet bytecode, on a local validator.
# Run it from Linux or WSL:  bash test.sh
#
# 1. builds the Hunch proof program and the test-only CPI probe (build.sh);
# 2. dumps DBC and Metaplex Token Metadata from mainnet once (read-only, public RPC) into the target folder;
# 3. starts a fresh solana-test-validator with those programs, Hunch and the probe in genesis;
# 4. runs tests/k1k3.mjs against it (throwaway keys made in memory), then stops the validator.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
target="${HUNCH_TARGET:-$HOME/hunch-target}"
export HUNCH_PROGRAM="ATxJHU3jCbm9fM6UKhZigZ2phpKKaa1UcbQXGsyYMwyT"
export PROBE_PROGRAM="J5rMHTxcFaQ3q9yzsn5DDiQGjCGnqt1pgwQUzTXqj5Kd"
DBC="dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"
MPL="metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"

bash ./build.sh

mainnet="$target/mainnet-programs"
mkdir -p "$mainnet"
# Meteora's current mainnet DBC (0.2.2) by default; DBC_SO=<path> selects another build (dbc.so: the one before)
[ -s "$mainnet/dbc-0.2.2.so" ] || solana program dump -u m "$DBC" "$mainnet/dbc-0.2.2.so"
dbc_so="${DBC_SO:-$mainnet/dbc-0.2.2.so}"
[ -s "$mainnet/mpl_token_metadata.so" ] || solana program dump -u m "$MPL" "$mainnet/mpl_token_metadata.so"
echo "DBC bytecode sha256: $(sha256sum "$dbc_so" | cut -c1-64) ($dbc_so)"

ledger="$target/ledger"
log="$target/validator.log"
solana-test-validator --reset --quiet --ledger "$ledger" \
  --bpf-program "$DBC" "$dbc_so" \
  --bpf-program "$MPL" "$mainnet/mpl_token_metadata.so" \
  --bpf-program "$HUNCH_PROGRAM" "$target/deploy/hunch.so" \
  --bpf-program "$PROBE_PROGRAM" "$target/deploy/hunch_cpi_probe.so" \
  > "$log" 2>&1 &
validator=$!
trap 'kill $validator 2>/dev/null; wait $validator 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do
  solana -u http://127.0.0.1:8899 cluster-version >/dev/null 2>&1 && break
  sleep 1
done
solana -u http://127.0.0.1:8899 cluster-version

node tests/k1k3.mjs
