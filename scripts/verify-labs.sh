#!/usr/bin/env bash
# Runs each lab's own `npm run check`, one lab at a time, and summarizes.
#
#   scripts/verify-labs.sh                 # every lab-* directory
#   scripts/verify-labs.sh lab-13-tool-governance lab-15-integrated-runtime
#
# This only orchestrates. Labs stay independent projects: nothing here is imported by a lab, it never
# edits a lab, and it never installs dependencies (a lab without node_modules is reported as SKIP, not
# fixed). Exit status is non-zero if any lab FAILs; SKIPs are reported but do not fail the run.
set -u

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root" || exit 2

if [ "$#" -gt 0 ]; then labs=("$@"); else labs=(lab-*/); fi

pass=0; fail=0; skip=0
summary=()
logdir="$(mktemp -d)"

for entry in "${labs[@]}"; do
  lab="${entry%/}"
  if [ ! -f "$lab/package.json" ]; then
    summary+=("SKIP  $lab  (no package.json)"); skip=$((skip + 1)); continue
  fi
  if ! grep -q '"check"' "$lab/package.json"; then
    summary+=("SKIP  $lab  (no \"check\" script)"); skip=$((skip + 1)); continue
  fi
  if [ ! -d "$lab/node_modules" ]; then
    summary+=("SKIP  $lab  (dependencies not installed; run 'npm ci' there)"); skip=$((skip + 1)); continue
  fi
  log="$logdir/$lab.log"
  if (cd "$lab" && npm run check >"$log" 2>&1); then
    tests="$(grep -Eo 'Tests +[0-9]+ passed' "$log" | tail -1 | tr -s ' ')"
    summary+=("PASS  $lab  ${tests:-}"); pass=$((pass + 1))
  else
    summary+=("FAIL  $lab  (log: $log)"); fail=$((fail + 1))
  fi
done

printf '%s\n' "${summary[@]}"
echo "---"
echo "pass=$pass fail=$fail skip=$skip"
[ "$fail" -eq 0 ]
