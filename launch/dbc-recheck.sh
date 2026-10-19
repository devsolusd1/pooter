#!/bin/bash
# Has Meteora upgraded its bonding-curve program (DBC) on mainnet since the bytecode Hunch was tested
# against? Read-only: it reads the program's ProgramData on mainnet through a public node and dumps the
# bytecode; it sends nothing anywhere.
#
#   bash dbc-recheck.sh              # one line: unchanged, or changed (with what to do)
#   RUN_SUITE=1 bash dbc-recheck.sh  # if it changed: save the new bytecode, and run the whole stage-2
#                                    # suite (programs/test-v1.sh) against it, on a snapshot of hunch/
#
# Known bytecode (sha256 of `solana program dump`):
#   4c26a8a5da99f8ce932fa0300c46675b527090021fbb74214c9486bedda9f23b  DBC 0.2.1, deployed slot 445503633 (2026-09-09)
#   e2bfc853c1a1778dd8ee40ea9a0f3edf5587442360c57c685e7e3024ad0cad47  DBC 0.2.2, deployed slot 457502600 (2026-10-16 04:23 UTC)
set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
here="$(cd "$(dirname "$0")" && pwd)"
target="${HUNCH_TARGET:-$HOME/hunch-target}"
DBC=dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN
TESTED="${TESTED_DBC_SHA256:-e2bfc853c1a1778dd8ee40ea9a0f3edf5587442360c57c685e7e3024ad0cad47}"
RPC="${READ_RPC:-https://api.mainnet-beta.solana.com}"   # a read-only node; never the key-bearing RPC_URL

info="$(solana program show -u "$RPC" "$DBC")"
slot="$(echo "$info" | sed -n 's/^Last Deployed In Slot: //p')"
when="$(solana block-time -u "$RPC" "$slot" 2>/dev/null | sed -n 's/^Date: //p' || true)"
mkdir -p "$target/mainnet-programs"
tmp="$(mktemp -d "$target/dbc-recheck.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
solana program dump -u "$RPC" "$DBC" "$tmp/dbc.so" >/dev/null
sha="$(sha256sum "$tmp/dbc.so" | cut -c1-64)"
echo "DBC on mainnet: last deployed in slot $slot (${when:-time unknown}), bytecode sha256 $sha"
if [ "$sha" = "$TESTED" ]; then
  echo "UNCHANGED: this is the bytecode the Hunch suite last passed against."
  exit 0
fi
saved="$target/mainnet-programs/dbc-$slot.so"
cp "$tmp/dbc.so" "$saved"
echo "CHANGED: Meteora has deployed new DBC bytecode. Saved as $saved (the older dumps are kept)."
if [ "${RUN_SUITE:-}" != "1" ]; then
  echo "Run the whole suite against it before launching:  RUN_SUITE=1 bash $here/dbc-recheck.sh"
  exit 2
fi
# the suite on a snapshot of hunch/, so that nothing in the working folders is rebuilt or rewritten
S="$target/snap-dbc-$slot"
rm -rf "$S"; mkdir -p "$S/hunch/site" "$S/hunch/sim" "$S/target/mainnet-programs"
H="$here/.."
rsync -a --exclude target "$H/programs" "$H/scripts" "$H/package.json" "$S/hunch/"
rsync -a "$H/site/core" "$H/site/data" "$S/hunch/site/"
rsync -a "$H/sim/data" "$S/hunch/sim/"
cp "$saved" "$S/target/mainnet-programs/dbc.so"
cp "$target/mainnet-programs/memo.so" "$target/mainnet-programs/mpl_token_metadata.so" "$S/target/mainnet-programs/"
for d in tests k2 hunch hunch-host hunch-wide cpi-probe; do [ -d "$target/$d" ] && cp -a "$target/$d" "$S/target/"; done
T="$S/target"
HUNCH_TARGET="$T" DBC_SO="$T/mainnet-programs/dbc.so" MPL_SO="$T/mainnet-programs/mpl_token_metadata.so" MEMO_SO="$T/mainnet-programs/memo.so" \
  HUNCH_SO="$T/deploy/hunch.so" PROBE_SO="$T/deploy/hunch_cpi_probe.so" HUNCH_WIDE_SO="$T/deploy-wide/hunch.so" \
  bash "$S/hunch/programs/test-v1.sh" > "$S/suite.log" 2>&1 && ok=1 || ok=0
grep -h "^test result" "$S/suite.log" | awk '{p+=$4; f+=$6} END {print "suite: " p " passed, " f " failed"}'
[ $ok = 1 ] && echo "PASS: the stage-2 suite passes against the new DBC bytecode (log $S/suite.log)" || { echo "FAIL: see $S/suite.log"; exit 1; }
