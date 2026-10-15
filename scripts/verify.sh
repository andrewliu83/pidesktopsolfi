#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 PI-Desktop SoL-Pi port contributors
# SPDX-License-Identifier: MIT
# Compatibility entrypoint; the portable Node runner owns the checks.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec node scripts/verify.mjs "$@"
