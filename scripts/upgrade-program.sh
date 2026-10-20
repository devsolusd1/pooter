#!/bin/bash
# Upgrades the LIVE Hunch (Pooter) program in place, keeping its address, its accounts and its budget.
# Dry by default: it builds, checks the build against TESTED_SHA256, reads the program on the cluster
# (its upgrade authority, the room in its ProgramData), prints what the upgrade needs at the peak and
# what it costs in the end (rent on mainnet: 5,080 lamports per byte, read from the cluster each time),
# and sends NOTHING unless SEND=1.
# Written for the withdraw_budget build (2026-10-20: 205,440 bytes against the deployed 196,864, so the
# ProgramData is extended by 8,576 bytes first). The State layout is unchanged; the accounts stay as they are.
#
#   TESTED_SHA256=<sha> bash upgrade-program.sh            # the plan
#   SEND=1 TESTED_SHA256=<sha> bash upgrade-program.sh     # the upgrade
#
# From Windows:  wsl -e bash -lc 'cd /mnt/c/Users/John/RafinhaProject/hunch/scripts && TESTED_SHA256=<sha> bash upgrade-program.sh'
#
# What SEND=1 does, in order, all signed by KEYPAIR (the program's upgrade authority; it also pays):
#   1. solana program extend, only if the new binary is larger than the room the ProgramData has (rent for
#      the added bytes, kept for good);
#   2. solana program write-buffer: the binary into a new buffer account (its rent comes back at step 4);
#   3. the buffer is dumped back and its sha256 compared with the build: nothing is upgraded otherwise;
#   4. solana program upgrade: the buffer replaces the program's code at the same address; the buffer is
#      closed and its rent returned to KEYPAIR;
#   5. the program is dumped back from the cluster and its sha256 compared with the build.
# If a step fails, the buffer (and its SOL) may be left: see "A stuck buffer" printed at the end.
#
# Settings come from the environment or from hunch/launch/.env (HUNCH_ENV_FILE names another file, for a
# local rehearsal); SEND never comes from a file. Nothing prints the RPC address or a key path: every line
# goes through a filter that hides them.
#   RPC_URL          the cluster (default: the public mainnet node)
#   CLUSTER          mainnet-beta (default) or localnet; the program address is program.json's entry for it
#   KEYPAIR          the program's upgrade authority (the developer's wallet): signs and pays
#   PRIORITY         micro-lamports per compute unit for the buffer writes (default 20000); the CLI sends
#                    extend and upgrade without one (it has no option for them)
#   TESTED_SHA256    REQUIRED to send: the sha256 of the binary test-v1.sh passed on; the build must match it
#   SO               a local rehearsal only: upgrade with this binary instead of building
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
hunch="$here/.."
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
target="${HUNCH_TARGET:-$HOME/hunch-target}"

envfile="${HUNCH_ENV_FILE:-$hunch/launch/.env}"
if [ -f "$envfile" ]; then
  while IFS='=' read -r k v; do
    k="$(echo "$k" | tr -d '[:space:]' | sed 's/^export//')"
    [[ "$k" =~ ^(RPC_URL|CLUSTER|KEYPAIR|PRIORITY|TESTED_SHA256)$ ]] || continue
    v="$(echo "$v" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^["'\'']//' -e 's/["'\'']$//')"
    [ -z "${!k:-}" ] && export "$k=$v"
  done < <(tr -d '\r' < "$envfile" | grep -v '^\s*#' | grep '=')
fi
SEND="${SEND:-}"
CLUSTER="${CLUSTER:-mainnet-beta}"
RPC="${RPC_URL:-https://api.mainnet-beta.solana.com}"
PRIORITY="${PRIORITY:-20000}"
expand() { local p="$1"; p="${p/#\~/$HOME}"; if [[ "$p" =~ ^([A-Za-z]):[\\/](.*)$ ]]; then p="/mnt/${BASH_REMATCH[1],,}/${BASH_REMATCH[2]//\\//}"; fi; echo "$p"; }
KEY="$(expand "${KEYPAIR:-}")"
# hide the RPC address and the key path from everything printed, ours and the CLI's (the same parts as
# deploy-program.sh and keepSecret in crank/hunch-program.mjs)
export HIDE_RPC="$RPC" HIDE_K1="$KEY" HIDE_K3="${KEYPAIR:-}"
export HIDE_LIST="$(node -e 'try{const u=new URL(process.argv[1]);console.log([u.href,u.host+u.pathname+u.search,u.username,u.password,...u.searchParams.values(),...u.pathname.split("/")].filter(s=>s&&s.length>=10).join("\n"))}catch{}' "$RPC" 2>/dev/null || true)"
hide() { perl -pe 'BEGIN{$|=1; @h=grep{length($_)>=6}map{$ENV{$_}}qw(HIDE_RPC HIDE_K1 HIDE_K3); push @h, grep{length($_)>=6} split /\n/, ($ENV{HIDE_LIST}//""); @h=sort{length($b)<=>length($a)}@h} for my $x (@h){s/\Q$x\E/<hidden>/g}'; }

main() {
pjson="$hunch/launch/program.json"
[ "$CLUSTER" = localnet ] && [ -n "${HUNCH_PROGRAM_FILE:-}" ] && pjson="$(expand "$HUNCH_PROGRAM_FILE")"
local_rpc=0; [[ "$RPC" =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]+)?/?$ ]] && local_rpc=1
if [ "$CLUSTER" = localnet ] && [ $local_rpc = 0 ]; then echo "REFUSED: CLUSTER is localnet but RPC_URL is not a local validator. Nothing was sent."; exit 1; fi
if [ "$CLUSTER" != localnet ] && [ $local_rpc = 1 ]; then echo "REFUSED: RPC_URL is a local validator but CLUSTER is $CLUSTER. Nothing was sent."; exit 1; fi

missing=()
if [ -n "${SO:-}" ]; then
  if [ "$CLUSTER" != localnet ]; then echo "REFUSED: SO (a given binary) is for a local rehearsal only; on $CLUSTER the binary is built here. Nothing was sent."; exit 1; fi
  so="$(expand "$SO")"
  echo "== binary given by SO (local rehearsal; not built here)"
else
  echo "== build (programs/build.sh, as test-v1.sh builds it)"
  HUNCH_TARGET="$target" bash "$hunch/programs/build.sh" | grep -v "^$" | tail -3
  so="$target/deploy/hunch.so"
fi
size=$(stat -c %s "$so")
sha=$(sha256sum "$so" | cut -c1-64)
echo "binary    $size bytes, sha256 $sha"
if [ -z "${TESTED_SHA256:-}" ]; then missing+=("TESTED_SHA256 is not given: run test-v1.sh on this source and pass the sha256 it printed for the binary")
elif [ "$TESTED_SHA256" != "$sha" ]; then missing+=("the build's sha256 is not TESTED_SHA256 ($TESTED_SHA256): this is not the binary the tests passed on"); fi

program_id=$(node -e 'const j=require(process.argv[1]); process.stdout.write(String(j[process.argv[2]] ?? ""))' "$pjson" "$CLUSTER" 2>/dev/null || true)
if [ -z "$program_id" ]; then echo "REFUSED: program.json has no program address for $CLUSTER. Nothing was sent."; exit 1; fi
echo "== the program on $CLUSTER"
echo "program   $program_id"
if ! shown=$(solana program show "$program_id" -u "$RPC" --output json 2>&1); then
  echo "REFUSED: no upgradeable program at $program_id on $CLUSTER: $shown"; echo "Nothing was sent."; exit 1
fi
field() { node -e 'const j=JSON.parse(process.argv[1]); const v=j[process.argv[2]]; process.stdout.write(v===undefined||v===null?"":String(v))' "$shown" "$1"; }
programdata=$(field programdataAddress); authority=$(field authority); room=$(field dataLen); last_slot=$(field lastDeploySlot)
echo "authority $authority (upgrade authority), last deployed at slot $last_slot"
echo "room      the ProgramData holds $room bytes of code"
deployed=$(mktemp); solana program dump "$program_id" "$deployed" -u "$RPC" >/dev/null
now_sha=$(head -c "$room" "$deployed" | sha256sum | cut -c1-64)
echo "now       sha256 of the deployed code $now_sha (whole ProgramData)"
# already this build? (after an extend the ProgramData is larger than the binary: compare its first bytes)
first_sha=""
if [ "$room" -ge "$size" ]; then first_sha=$(head -c "$size" "$deployed" | sha256sum | cut -c1-64); fi
rm -f "$deployed"
if [ "$first_sha" = "$sha" ]; then echo; echo "Already upgraded: the program on $CLUSTER is this build (sha256 $sha). Nothing to send."; exit 0; fi

lamports() { solana rent "$1" -u "$RPC" --lamports 2>/dev/null | grep -o '[0-9]*' | head -1; }
per_byte=$(( $(lamports 10045) - $(lamports 45) ))
extra=$(( size > room ? size - room : 0 ))
# mainnet's loader refuses an ExtendProgram of fewer than 10,240 bytes (unless it reaches the maximum size)
if [ "$extra" -gt 0 ] && [ "$extra" -lt 10240 ]; then extra=10240; fi
rent_extend=0
if [ "$extra" -gt 0 ]; then rent_extend=$(( $(lamports $((45 + room + extra))) - $(lamports $((45 + room))) )); fi
rent_buf=$(lamports $((size + 37)))
writes=$(( (size + 1011) / 1012 ))
txs=$(( writes + 3 + (extra > 0 ? 1 : 0) ))
fees=$(( txs * (5000 + 2 * 200000 * PRIORITY / 1000000) ))
peak=$(( rent_buf + rent_extend + fees ))
cost=$(( rent_extend + fees ))
sol() { awk -v l="$1" 'BEGIN { printf "%.6f", l / 1e9 }'; }
echo "== what it needs (rent on $CLUSTER: $(awk -v l="$per_byte" 'BEGIN { printf "%.0f", l / 10000 }') lamports per byte)"
if [ "$extra" -gt 0 ]; then
  echo "extend    the new binary needs $(( size - room )) more bytes; the program is extended by $extra (the loader's minimum is 10,240): solana program extend $program_id $extra"
  echo "          rent for the added bytes $(sol $rent_extend) SOL (kept by the program for good)"
else
  echo "extend    not needed: the binary fits the room ($size of $room bytes)"
fi
echo "buffer    $(sol $rent_buf) SOL of rent while the binary is uploaded; it comes back when the upgrade closes the buffer"
echo "fees      about $txs transactions ($writes buffer writes): at most about $(sol $fees) SOL at $PRIORITY micro-lamports/CU"
echo "needs     about $(sol $peak) SOL in the wallet at the peak; about $(sol $cost) SOL spent in the end"

echo "== the wallet"
if [ -z "${KEYPAIR:-}" ] || [ ! -f "$KEY" ]; then
  missing+=("KEYPAIR is not set, or no key file is there (the program's upgrade authority)")
else
  wallet=$(solana-keygen pubkey "$KEY")
  bal=$(solana balance "$wallet" -u "$RPC" --lamports 2>/dev/null | grep -o '^[0-9]*' || echo 0)
  echo "wallet    $wallet ($(sol "$bal") SOL)"
  [ "$wallet" != "$authority" ] && missing+=("KEYPAIR ($wallet) is not the program's upgrade authority ($authority)")
  [ "$bal" -lt "$peak" ] && missing+=("the wallet holds $(sol "$bal") SOL; the upgrade needs about $(sol $peak) at the peak")
fi

if [ ${#missing[@]} -gt 0 ]; then echo; echo "NOT READY TO SEND:"; for m in "${missing[@]}"; do echo "  - $m"; done; fi
if [ "$SEND" != "1" ]; then echo; echo "Nothing was sent. To upgrade:  SEND=1 TESTED_SHA256=$sha bash upgrade-program.sh"; exit 0; fi
if [ ${#missing[@]} -gt 0 ]; then echo; echo "REFUSED: not sending while the list above stands. Nothing was sent."; exit 1; fi

trap 'echo; echo "STOPPED before the end."; stuck' ERR
before=$bal
# keep the extend and the switch away from the crank: ticks land in the first 30 seconds of each 10-minute
# bar (a program changed in a slot cannot be called again until the next one), so act between second 40
# and second 540 of a bar
clear_of_ticks() { local s; while s=$(( $(date -u +%s) % 600 )); [ "$s" -lt 40 ] || [ "$s" -gt 540 ]; do echo "waiting for the crank's tick window to pass ($s s into the bar)"; sleep 5; done; }
if [ "$extra" -gt 0 ]; then
  echo; echo "== 1. extend the ProgramData by $extra bytes"
  clear_of_ticks
  solana program extend "$program_id" "$extra" -u "$RPC" --keypair "$KEY" --commitment confirmed
fi
bufkey="$target/upgrade-buffer-$program_id-$sha.json"
[ -f "$bufkey" ] || solana-keygen new --no-bip39-passphrase --silent --force -o "$bufkey" >/dev/null
buffer=$(solana-keygen pubkey "$bufkey")
echo; echo "== 2. write the binary into buffer $buffer"
solana program write-buffer "$so" -u "$RPC" --keypair "$KEY" --buffer "$bufkey" --buffer-authority "$KEY" \
  --with-compute-unit-price "$PRIORITY" --max-sign-attempts 50 --commitment confirmed
echo; echo "== 3. check the buffer"
got_buf=$(mktemp); solana program dump "$buffer" "$got_buf" -u "$RPC" >/dev/null
bsha=$(head -c "$size" "$got_buf" | sha256sum | cut -c1-64); rm -f "$got_buf"
if [ "$bsha" != "$sha" ]; then echo "REFUSED: the buffer holds sha256 $bsha, not the build ($sha). The program was not upgraded."; stuck; exit 1; fi
echo "the buffer is byte for byte the build (sha256 $sha)"
echo; echo "== 4. upgrade $program_id from the buffer"
clear_of_ticks
solana program upgrade "$buffer" "$program_id" -u "$RPC" --keypair "$KEY" --upgrade-authority "$KEY" --commitment confirmed
trap - ERR
echo; echo "== 5. check what landed"
solana program show "$program_id" -u "$RPC" | sed -n '1,8p'
dump="$target/upgraded-$CLUSTER-$program_id.so"
solana program dump "$program_id" "$dump" -u "$RPC" >/dev/null
got=$(head -c "$size" "$dump" | sha256sum | cut -c1-64)
after=$(solana balance "$wallet" -u "$RPC" --lamports 2>/dev/null | grep -o '^[0-9]*' || echo 0)
if [ "$got" = "$sha" ]; then echo "the program on $CLUSTER is byte for byte the build (sha256 $sha)"; else echo "WARNING: the program on $CLUSTER (sha256 $got) is NOT the build ($sha)"; exit 1; fi
if solana account "$buffer" -u "$RPC" >/dev/null 2>&1; then echo "note: the buffer $buffer still exists; see below to close it"; stuck; else echo "the buffer is closed; its rent is back in the wallet"; rm -f "$bufkey"; fi
echo "wallet    $(sol "$before") SOL before, $(sol "$after") SOL after: the upgrade cost $(sol $((before - after))) SOL"
}

stuck() {
  cat <<EOF

A stuck buffer. If the upload or the upgrade stopped half way, a buffer account may still hold its rent
(about $(awk -v l="${rent_buf:-0}" 'BEGIN { printf "%.4f", l / 1e9 }') SOL). The program itself is unchanged until step 4 lands.
  See it:        solana program show --buffers -u <your RPC_URL> --keypair <your KEYPAIR>
  Resume:        run this script again with SEND=1: it uses the same buffer address (its key file is kept in
                 the build folder until the upgrade lands), so no second buffer is paid for.
  Get the SOL:   solana program close --buffers -u <your RPC_URL> --keypair <your KEYPAIR>
                 (closes only BUFFER accounts of that authority and sends their SOL back to it). Never give
                 \`solana program close\` the program's own address: that would close the program for good.
EOF
}

main 2>&1 | hide
exit "${PIPESTATUS[0]}"
