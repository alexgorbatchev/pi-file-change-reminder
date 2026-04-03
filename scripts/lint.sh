#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/set-tsx-node-options.sh"

oxlint -c oxlint.config.ts src/fileChangeReminderExtension.ts oxfmt.config.ts oxlint.config.ts
