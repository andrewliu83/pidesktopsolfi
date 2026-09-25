#!/usr/bin/env bash
#
# SPDX-FileCopyrightText: Copyright (c) 2026 PI-Desktop SoL-Pi port contributors
# SPDX-License-Identifier: MIT
#
# Everything this port can verify without launching PI-Desktop, in one command:
#
#   1. every source file parses
#   2. the shipped manifest.json is exactly what lib/metadata.js generates
#   3. the unit tests pass (node:test, no dependencies)
#   4. the offline host gate passes against a strict stub of the real plugin API
#   5. with --mutations, the gate is proven to fail on a deliberately broken plugin
#
# Usage:
#   bash scripts/verify.sh
#   bash scripts/verify.sh --mutations
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root" || exit 1

failures=0
steps=0
with_mutations=0
for argument in "$@"; do
  [ "$argument" = "--mutations" ] && with_mutations=1
done

run_step() {
  local name="$1"
  shift
  steps=$((steps + 1))
  printf '\n\033[1m── %s\033[0m\n' "$name"
  if "$@"; then
    printf '   ok\n'
  else
    printf '   FAILED: %s\n' "$name"
    failures=$((failures + 1))
  fi
}

check_syntax() {
  local failed=0
  local file
  for file in lib/*.js hooks/*.js main.js eval/*.js views/*.js scripts/*.mjs; do
    [ -e "$file" ] || continue
    if ! node --check "$file" > /dev/null 2>&1; then
      printf '   %s does not parse\n' "$file"
      failed=1
    fi
  done
  [ "$failed" -eq 0 ] || return 1
  printf '   %s files parse\n' "$(ls lib/*.js hooks/*.js main.js eval/*.js views/*.js scripts/*.mjs | wc -l | tr -d ' ')"
}

run_step "Syntax of every source file" check_syntax
run_step "manifest.json matches lib/metadata.js" node scripts/sync-manifest.mjs --check
run_step "Unit tests (node:test)" node --test test/*.test.js
run_step "Offline host gate (eval/offline-check.js)" node eval/offline-check.js

if [ "$with_mutations" -eq 1 ]; then
  run_step "Mutation gate (eval/mutation-check.sh)" bash eval/mutation-check.sh
fi

printf '\n%s\n' "── Summary"
if [ "$failures" -eq 0 ]; then
  printf '\033[32m   all %s steps passed\033[0m\n\n' "$steps"
  exit 0
fi
printf '\033[31m   %s of %s steps failed\033[0m\n\n' "$failures" "$steps"
exit 1
