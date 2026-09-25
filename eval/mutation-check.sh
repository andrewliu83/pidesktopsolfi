#!/usr/bin/env bash
#
# SPDX-FileCopyrightText: Copyright (c) 2026 PI-Desktop SoL-Pi port contributors
# SPDX-License-Identifier: MIT
#
# Prove eval/offline-check.js cannot false-green.
#
# A gate that passes is only evidence if it would have failed on a broken plugin.
# This script copies the plugin, breaks one specific guarantee at a time, and
# requires the gate to report the matching failure by name. It never touches the
# working tree, and it refuses to mutate if an anchor is not unique, so a silent
# no-op mutation cannot be mistaken for a caught defect.
#
# Usage: bash eval/mutation-check.sh
set -uo pipefail

plugin_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/sol-pi-mutation-XXXXXX")"
report="$work/gate.txt"
trap 'rm -rf "$work"' EXIT

copy_plugin() {
  local destination="$1"
  rm -rf "$destination"
  mkdir -p "$destination"
  (cd "$plugin_root" && tar --exclude ./.git --exclude ./node_modules -cf - .) |
    (cd "$destination" && tar -xf -)
}

# name, file, anchor, replacement, expected failure marker(s) separated by ';'
mutations=(
  "opt-in removed (a disabled mechanism stops refusing)"
  "lib/config.js"
  '!config || config\[mechanism\] !== true'
  'false'
  'FAIL fused_edit refuses while actionFusion is off'

  "manifest drift (a renamed tool)"

  "manifest.json"
  '"name": "obs_pack"'
  '"name": "obs_pack_v2"'
  'FAIL onLoad registers exactly the manifest;FAIL the shipped manifest and the metadata module agree'

  "archive drops the last byte of the evidence"
  "lib/observation-pack.js"
  'writeFile(observation.text,'
  'writeFile(observation.text.slice(0, -1),'
  'FAIL obs_recall pages the exact bytes back'

  "a fabricated quote is accepted"
  "lib/reducer.js"
  '!body.includes(quote)'
  'false'
  'FAIL a fabricated quote is rejected'

  "an invented host API is called"
  "lib/host.js"
  'host.session.getLlmContext()'
  'host.session.getLlmContextV2()'
  'FAIL obs_pack scan packs an oversized tool result;FAIL compact_check measures'

  "the credential guard is weakened"
  "lib/action-fusion.js"
  'id_rsa\.\*|'
  ''
  'FAIL credentials, absolute paths and escapes are refused'

  "the scan packs its own fused verdict anyway"
  "lib/tools.js"
  'if (fusedThenRunResult(content, message.toolName)) {'
  'if (fusedThenRunResult("", "")) {'
  'FAIL scan leaves its own fused-call results alone'

  "the session fallback is disarmed"
  "lib/host.js"
  'host.session.get({ id: sessionId })'
  'host.session.get({ id: "" })'
  "FAIL the session's own project folder answers when the window has none"

  "the hook route stops honoring upstream's two full sends"
  "hooks/agent-hooks.js"
  'previousSends < observation.FULL_SENDS'
  'previousSends <= observation.FULL_SENDS'
  'FAIL a large result is full for its first two sends, then exact-placeholder'

  "the hook route projects even when packing is switched off"
  "hooks/agent-hooks.js"
  'archive.config.observationPack !== true'
  'archive.config.observationPack === true'
  'FAIL switching packing off returns the messages byte-identical and archives nothing'

  "the per-turn record stops honoring its own switch"
  "hooks/agent-hooks.js"
  'archive.config.turnMeasurement !== true'
  'archive.config.turnMeasurement === true'
  'FAIL the per-turn record is written once per turn, and returns nothing;FAIL switching the measurement off writes nothing'

  "the per-turn record is mixed into the observation ledger"
  "hooks/agent-hooks.js"
  'paths.hookLedgerPath(root)'
  'paths.observationLedgerPath(root)'
  'FAIL the per-turn record is written once per turn, and returns nothing'

  "the panel forgets the route that announced itself"
  "lib/tools.js"
  'if (basename(root) !== "shared") candidates.push(join(dirname(root), "shared"));'
  'if (false) candidates.push(join(dirname(root), "shared"));'
  'FAIL the status file says which route is live, and the panel can read it'

  "the status write stops creating its own directory"
  "hooks/agent-hooks.js"
  'await mkdir(dirname(target), { recursive: true, mode: 0o700 });'
  ''
  'FAIL the status file says which route is live, and the panel can read it'

  "the panel lets a repeated packing overwrite one observation's saving"
  "lib/tools.js"
  'if (!previous.counted && removed > 0) {'
  'if (removed > 0) {'
  'FAIL a large result is full for its first two sends, then exact-placeholder'
)

failures=0
caught=0
total=$((${#mutations[@]} / 5))

printf '\n%s\n' "── Baseline: the unmutated copy must pass"
baseline_dir="$work/baseline"
copy_plugin "$baseline_dir"
if (cd "$baseline_dir" && node eval/offline-check.js) > "$report" 2>&1; then
  printf '  ok   the gate is green before any mutation (%s)\n' "$(tail -1 "$report")"
else
  printf '  FAIL the gate is already red; mutations would prove nothing\n'
  sed -n '1,40p' "$report" | sed 's/^/       /'
  exit 2
fi

printf '\n%s\n' "── Each mutation must be caught, by name"
index=0
while [ "$index" -lt "${#mutations[@]}" ]; do
  name="${mutations[$index]}"
  file="${mutations[$((index + 1))]}"
  anchor="${mutations[$((index + 2))]}"
  replacement="${mutations[$((index + 3))]}"
  expected="${mutations[$((index + 4))]}"
  index=$((index + 5))

  target_dir="$work/mutated-$index"
  copy_plugin "$target_dir"
  target_file="$target_dir/$file"

  occurrences="$(grep -c -e "$anchor" "$target_file" || true)"
  if [ "$occurrences" != "1" ]; then
    printf '  ERROR %s — anchor appears %s times in %s, refusing to mutate\n' "$name" "$occurrences" "$file"
    failures=$((failures + 1))
    continue
  fi

  sed "s#$anchor#$replacement#" "$target_file" > "$target_file.mutated" &&
    mv "$target_file.mutated" "$target_file"
  if [ -n "$replacement" ] && ! grep -q -e "$replacement" "$target_file"; then
    printf '  ERROR %s — the mutation did not land in %s\n' "$name" "$file"
    failures=$((failures + 1))
    continue
  fi

  status=0
  (cd "$target_dir" && node eval/offline-check.js) > "$report" 2>&1 || status=$?

  matched=""
  saved_ifs="$IFS"
  IFS=';'
  for marker in $expected; do
    if grep -q -F -e "$marker" "$report"; then
      matched="$marker"
      break
    fi
  done
  IFS="$saved_ifs"

  if [ "$status" -eq 0 ]; then
    printf '  SURVIVED %s — the gate stayed green on a broken plugin\n' "$name"
    failures=$((failures + 1))
  elif [ -z "$matched" ]; then
    printf '  WRONG    %s — the gate failed, but not on the expected check\n' "$name"
    grep -F 'FAIL' "$report" | sed 's/^/       /'
    failures=$((failures + 1))
  else
    printf '  caught   %s\n           %s\n' "$name" "$matched"
    caught=$((caught + 1))
  fi
done

printf '\n%s\n' "── Summary"
printf '  %s/%s mutations caught by name, %s problem(s)\n\n' "$caught" "$total" "$failures"
[ "$failures" -eq 0 ] || exit 1
exit 0
