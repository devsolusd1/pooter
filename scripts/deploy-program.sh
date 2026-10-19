#!/bin/bash
# Builds and deploys the Hunch program. Dry by default: it builds, prints the size, the rent and what
# the deployer wallet needs, checks the cluster, and sends NOTHING unless SEND=1.
#
#   bash deploy-program.sh                 # the plan
#   SEND=1 bash deploy-program.sh          # deploy (first time only; an existing program is refused)
#
# From Windows:  wsl -e bash -lc 'cd /mnt/c/Users/John/RafinhaProject/hunch/scripts && bash deploy-program.sh'
#
# Environment (or hunch/launch/.env; SEND only from the command line). No key path, no key and no RPC
# address is ever printed: every line of output goes through a filter that hides them.
#   RPC_URL          the cluster (default: the public mainnet node, slow for a deploy)
#   CLUSTER          mainnet-beta (default) or localnet; names the program.json entry written after a deploy
#   KEYPAIR          the deployer wallet: pays, and becomes the program's UPGRADE AUTHORITY (it stays upgradeable)
#   PROGRAM_KEYPAIR  the key file of the program's address (made beforehand, e.g. solana-keygen grind)
#   PRIORITY         micro-lamports per compute unit for the write transactions (default 20000)
#   TESTED_SHA256    optional: refuse unless the build has this sha256 (the one test-v1.sh ran against)
#
# The binary is built exactly as test-v1.sh builds the one it tests (programs/build.sh: cargo build-sbf,
# release, opt-level s, fat LTO, offline). --max-len is the binary's size, so a later, larger version
# needs `solana program extend <id> <bytes>` (rent for the added bytes) before the upgrade.
# After a deploy the program is dumped back from the cluster and its sha256 compared with the build.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
hunch="$here/.."
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
target="${HUNCH_TARGET:-$HOME/hunch-target}"

# settings from hunch/launch/.env where the environment has not set them (SEND never comes from it)
if [ -f "$hunch/launch/.env" ]; then
  while IFS='=' read -r k v; do
    k="$(echo "$k" | tr -d '[:space:]' | sed 's/^export//')"
    [[ "$k" =~ ^(RPC_URL|CLUSTER|KEYPAIR|PROGRAM_KEYPAIR|PRIORITY|TESTED_SHA256)$ ]] || continue
    v="$(echo "$v" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^["'\'']//' -e 's/["'\'']$//')"
    [ -z "${!k:-}" ] && export "$k=$v"
  done < <(tr -d '\r' < "$hunch/launch/.env" | grep -v '^\s*#' | grep '=')
fi
SEND="${SEND:-}"
CLUSTER="${CLUSTER:-mainnet-beta}"
RPC="${RPC_URL:-https://api.mainnet-beta.solana.com}"
PRIORITY="${PRIORITY:-20000}"
expand() { local p="$1"; p="${p/#\~/$HOME}"; if [[ "$p" =~ ^([A-Za-z]):[\\/](.*)$ ]]; then p="/mnt/${BASH_REMATCH[1],,}/${BASH_REMATCH[2]//\\//}"; fi; echo "$p"; }
KEY="$(expand "${KEYPAIR:-}")"
PKEY="$(expand "${PROGRAM_KEYPAIR:-}")"
# hide the RPC address and both key paths from everything printed, ours and the CLI's
export HIDE_RPC="$RPC" HIDE_K1="$KEY" HIDE_K2="$PKEY" HIDE_K3="${KEYPAIR:-}" HIDE_K4="${PROGRAM_KEYPAIR:-}"
# and every part of the RPC address as other programs print it: the solana CLI's errors show the address as
# its HTTP library normalises it ("https://host?api-key=K" becomes "https://host/?api-key=K"), which the
# exact string does not match. The same parts as keepSecret in crank/hunch-program.mjs: the normalised
# address, host + path + query, user, password, each query value, each path part (10 characters or more).
export HIDE_LIST="$(node -e 'try{const u=new URL(process.argv[1]);console.log([u.href,u.host+u.pathname+u.search,u.username,u.password,...u.searchParams.values(),...u.pathname.split("/")].filter(s=>s&&s.length>=10).join("\n"))}catch{}' "$RPC" 2>/dev/null || true)"
hide() { perl -pe 'BEGIN{$|=1; @h=grep{length($_)>=6}map{$ENV{$_}}qw(HIDE_RPC HIDE_K1 HIDE_K2 HIDE_K3 HIDE_K4); push @h, grep{length($_)>=6} split /\n/, ($ENV{HIDE_LIST}//""); @h=sort{length($b)<=>length($a)}@h} for my $x (@h){s/\Q$x\E/<hidden>/g}'; }

main() {
pjson="$hunch/launch/program.json"
[ "$CLUSTER" = localnet ] && [ -n "${HUNCH_PROGRAM_FILE:-}" ] && pjson="$(expand "$HUNCH_PROGRAM_FILE")"   # a local rehearsal keeps its own
local_rpc=0; [[ "$RPC" =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]+)?/?$ ]] && local_rpc=1
if [ "$CLUSTER" = localnet ] && [ $local_rpc = 0 ]; then echo "REFUSED: CLUSTER is localnet but RPC_URL is not a local validator. Nothing was sent."; exit 1; fi
if [ "$CLUSTER" != localnet ] && [ $local_rpc = 1 ]; then echo "REFUSED: RPC_URL is a local validator but CLUSTER is $CLUSTER. Nothing was sent."; exit 1; fi

missing=()
if [ -n "${SO:-}" ] && [ "$CLUSTER" = localnet ]; then
  so="$(expand "$SO")"   # a local rehearsal may deploy a given build
  echo "== binary given by SO (local rehearsal; not built here)"
else
  echo "== build (programs/build.sh, as test-v1.sh builds it)"
  bash "$hunch/programs/build.sh" | grep -v "^$" | tail -3
  so="$target/deploy/hunch.so"
fi
size=$(stat -c %s "$so")
sha=$(sha256sum "$so" | cut -c1-64)
echo "binary    $size bytes, sha256 $sha"
if [ -n "${TESTED_SHA256:-}" ] && [ "$TESTED_SHA256" != "$sha" ]; then missing+=("the build's sha256 is not TESTED_SHA256: run test-v1.sh on this source first"); fi

lamports() { solana rent "$1" -u "$RPC" --lamports 2>/dev/null | grep -o '[0-9]*' | head -1; }
rent_pd=$(lamports $((size + 45)))      # ProgramData: 45-byte header + the program, kept for good
rent_buf=$(lamports $((size + 37)))     # the upload buffer: 37-byte header; closed into the deployer at the end
rent_prog=$(lamports 36)                # the program account
writes=$(( (size + 1011) / 1012 ))      # write transactions of about 1 KB each
fees=$(( (writes + 4) * (5000 + 2 * 200000 * PRIORITY / 1000000) ))
peak=$(( rent_pd + rent_buf + rent_prog + fees ))
cost=$(( rent_pd + rent_prog + fees ))
sol() { awk -v l="$1" 'BEGIN { printf "%.6f", l / 1e9 }'; }
echo "rent      program data $(sol $rent_pd) SOL (kept), program account $(sol $rent_prog) SOL (kept)"
echo "          upload buffer $(sol $rent_buf) SOL (only during the deploy; it comes back)"
echo "fees      about $writes write transactions: at most about $(sol $fees) SOL at $PRIORITY micro-lamports/CU"
echo "needs     about $(sol $peak) SOL in the deployer wallet during the deploy; it costs about $(sol $cost) SOL in the end"
echo "max-len   $size (the binary's size; a larger version later needs solana program extend first)"

echo "== cluster ($CLUSTER)"
[ -z "${KEYPAIR:-}" ] || [ ! -f "$KEY" ] && missing+=("KEYPAIR is not set, or no key file is there (the deployer, who becomes the upgrade authority)")
[ -z "${PROGRAM_KEYPAIR:-}" ] || [ ! -f "$PKEY" ] && missing+=("PROGRAM_KEYPAIR is not set, or no key file is there (the program's address)")
program_id=""; deployer=""
if [ -f "$PKEY" ]; then program_id=$(solana-keygen pubkey "$PKEY"); echo "program   $program_id"; fi
if [ -f "$KEY" ]; then
  deployer=$(solana-keygen pubkey "$KEY")
  bal=$(solana balance "$deployer" -u "$RPC" --lamports 2>/dev/null | grep -o '^[0-9]*' || echo 0)
  echo "deployer  $deployer ($(sol "$bal") SOL), will be the upgrade authority"
  [ "$bal" -lt "$peak" ] && missing+=("the deployer holds $(sol "$bal") SOL; the deploy needs about $(sol $peak)")
fi
if [ -n "$program_id" ]; then
  if shown=$(solana program show "$program_id" -u "$RPC" 2>&1); then
    echo "REFUSED: a program is already deployed at $program_id on $CLUSTER:"
    echo "$shown" | sed -n '1,8p'
    echo "This script only makes the first deploy. An upgrade is: solana program deploy $so --program-id $program_id --upgrade-authority <the upgrade authority> (after solana program extend if larger). Nothing was sent."
    exit 1
  fi
  in_json=$(node -e 'const j=require(process.argv[1]); process.stdout.write(String(j[process.argv[2]] ?? ""))' "$pjson" "$CLUSTER" 2>/dev/null || true)
  if [ -n "$in_json" ] && [ "$in_json" != "$program_id" ]; then missing+=("hunch/launch/program.json names $in_json for $CLUSTER, not $program_id"); fi
fi

if [ ${#missing[@]} -gt 0 ]; then echo; echo "NOT READY TO SEND:"; for m in "${missing[@]}"; do echo "  - $m"; done; fi
if [ "$SEND" != "1" ]; then echo; echo "Nothing was sent. To deploy:  SEND=1 bash deploy-program.sh"; exit 0; fi
if [ ${#missing[@]} -gt 0 ]; then echo; echo "REFUSED: not sending while the list above stands. Nothing was sent."; exit 1; fi

echo; echo "== deploying $program_id ($size bytes) ..."
solana program deploy "$so" -u "$RPC" --keypair "$KEY" --program-id "$PKEY" --upgrade-authority "$KEY" \
  --max-len "$size" --with-compute-unit-price "$PRIORITY" --commitment confirmed
echo "== checking what landed"
solana program show "$program_id" -u "$RPC" | sed -n '1,8p'
dump="$target/deployed-$CLUSTER-$program_id.so"
solana program dump "$program_id" "$dump" -u "$RPC" >/dev/null
got=$(head -c "$size" "$dump" | sha256sum | cut -c1-64)
if [ "$got" = "$sha" ]; then echo "the program on $CLUSTER is byte for byte the build (sha256 $sha)"; else echo "WARNING: the program on $CLUSTER (sha256 $got) is NOT the build ($sha)"; exit 1; fi
node -e '
const fs = require("fs"); const f = process.argv[1]; const j = JSON.parse(fs.readFileSync(f, "utf8"));
if (!j[process.argv[2]]) { j[process.argv[2]] = process.argv[3]; fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n"); console.log(`written to program.json for ${process.argv[2]}`); }
' "$pjson" "$CLUSTER" "$program_id"
echo "Next: node init-hunch.mjs (plan), then SEND=1 STEP=initialize node init-hunch.mjs"
}

main 2>&1 | hide
exit "${PIPESTATUS[0]}"
