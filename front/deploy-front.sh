#!/usr/bin/env bash
# Deploys the Trekker front. Same shape as its sibling apps': rsync into a release
# directory, build on the server, atomic switch keeping the previous version as
# a backup, pm2 reload, automatic rollback if anything fails after the switch.
#
# Usage: ./deploy-front.sh [deploy|rollback]

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../scripts/deploy-common.sh
source "$SCRIPT_DIR/../scripts/deploy-common.sh"

load_deploy_config

REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WEB_ROOT="$TREKKER_REMOTE_ROOT"
CURRENT_DIR="$WEB_ROOT/public_html"
BACKUP_DIR="$WEB_ROOT/public_html.bak"
RELEASES_DIR="$WEB_ROOT/front-releases"
# The deployed unit is the whole pnpm workspace — the lockfile lives at the repo
# root, so shipping only front/ leaves --frozen-lockfile nothing to work from.
# $CURRENT_DIR is therefore the workspace root and the Next app sits in front/.
APP_SUBDIR="front"
# Committed and rsynced with the rest of the front — it holds no secrets.
PM2_ECOSYSTEM_FILE="$APP_SUBDIR/ecosystem.config.cjs"

remote_pm2_reload() {
  ssh "$TREKKER_DEPLOY_HOST" \
    CURRENT_DIR="$CURRENT_DIR" \
    PM2_ECOSYSTEM_FILE="$PM2_ECOSYSTEM_FILE" \
    REMOTE_PATH="$REMOTE_PATH" \
    'bash -s' << 'EOF'
set -Eeuo pipefail
export PATH="$REMOTE_PATH:$PATH"
cd "$CURRENT_DIR"
[ -f "$PM2_ECOSYSTEM_FILE" ] || { echo "❌ ERROR: missing $CURRENT_DIR/$PM2_ECOSYSTEM_FILE" >&2; exit 1; }
pm2 startOrReload "$CURRENT_DIR/$PM2_ECOSYSTEM_FILE" --update-env
pm2 save

# The front's own config holds no secrets, but `pm2 save` rewrites the one
# dump.pm2 shared by every process on this box — the API's resolved environment,
# master key included, among them. So this deploy loosens the API's secret if it
# does not tighten it back (TRE-54).
chmod 600 "$HOME/.pm2/dump.pm2" 2>/dev/null || true
EOF
}

remote_rollback() {
  ssh "$TREKKER_DEPLOY_HOST" \
    CURRENT_DIR="$CURRENT_DIR" \
    BACKUP_DIR="$BACKUP_DIR" \
    'bash -s' << 'EOF'
set -Eeuo pipefail
[ -d "$BACKUP_DIR" ] || { echo "❌ ERROR: no backup at $BACKUP_DIR" >&2; exit 1; }
rm -rf "$CURRENT_DIR"
mv "$BACKUP_DIR" "$CURRENT_DIR"
echo "✅ Front rollback done (restored from backup)"
EOF
}

# The pnpm version is deliberately not written down here. Each project pins it
# in package.json ("packageManager") and both machines switch to that version on
# their own. What this guards is the *baseline* pnpm — the binary that performs
# the switch. A server baseline older than this machine's may not honour the pin
# at all, in which case the build would quietly run on the wrong pnpm.
#
# npm_config_manage_package_manager_versions=false bypasses the pin: without it
# both sides would report the pinned version and the comparison would prove
# nothing. It has to be the environment variable — the equivalent
# `--config.manage-package-manager-versions=false` flag is silently ignored
# here, because the version switch happens before flags are parsed.
check_pnpm_baseline() {
  local local_v remote_v oldest

  local_v=$(npm_config_manage_package_manager_versions=false pnpm -v 2>/dev/null) || {
    echo "❌ ERROR: pnpm not found on this machine" >&2
    exit 1
  }

  remote_v=$(ssh "$TREKKER_DEPLOY_HOST" \
    'export PATH="$HOME/.local/share/pnpm:$PATH"; npm_config_manage_package_manager_versions=false pnpm -v' \
    2>/dev/null) || {
    echo "❌ ERROR: pnpm not found on the server" >&2
    exit 1
  }

  oldest=$(printf '%s\n%s\n' "$local_v" "$remote_v" | sort -V | head -1)
  if [ "$remote_v" != "$local_v" ] && [ "$oldest" = "$remote_v" ]; then
    echo "❌ ERROR: the server's pnpm ($remote_v) is older than this machine's ($local_v)." >&2
    echo "   Update pnpm on the server before deploying." >&2
    exit 1
  fi

  log "➡️  pnpm baseline — local $local_v / server $remote_v"
}

deploy() {
  check_pnpm_baseline
  cd "$SCRIPT_DIR"
  require_clean_tree
  # Before the ERR trap below, and before anything reaches the server: a failing
  # check must read as "nothing was uploaded", not as a deploy that rolled back.
  run_preflight_checks
  compute_release_metadata
  zeus_init "front"

  local STAGING_DIR="$RELEASES_DIR/$RELEASE_NAME"
  local SWITCH_DONE="false"

  on_error() {
    log "❌ ERROR: front deployment failed at line $1"
    if [[ "$SWITCH_DONE" == "true" ]]; then
      log "↩️  Auto rollback: restoring previous front"
      if remote_rollback; then
        remote_pm2_reload || true
        log "✅ Auto rollback succeeded"
        # `rolled_back`, not `failed` — the deploy did fail, and the box is
        # serving exactly what it served before.
        zeus_report "rolled_back" "deploy failed at line $1 — previous release restored" || true
      else
        log "❌ Auto rollback failed, manual intervention required"
        zeus_report "failed" "deploy failed at line $1 — rollback failed too" || true
      fi
    else
      log "ℹ️  No rollback needed: production was not modified yet"
      zeus_report "failed" "deploy failed at line $1 — production was not modified" || true
    fi
  }
  trap 'on_error $LINENO' ERR

  log "➡️  Preparing staging directory"
  ssh "$TREKKER_DEPLOY_HOST" \
    RELEASES_DIR="$RELEASES_DIR" \
    STAGING_DIR="$STAGING_DIR" \
    'bash -s' << 'EOF'
set -Eeuo pipefail
mkdir -p "$RELEASES_DIR"
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"
EOF

  log "➡️  Uploading workspace sources"
  rsync -az --delete \
    --exclude ".git" \
    --exclude ".next" \
    --exclude "node_modules" \
    --exclude "out" \
    --exclude "dist" \
    --exclude "generated" \
    --exclude ".env" \
    --exclude "deploy.env" \
    --exclude "ecosystem.config.js" \
    --exclude ".DS_Store" \
    "$REPO_ROOT/" "$TREKKER_DEPLOY_HOST:$STAGING_DIR/"

  log "➡️  Installing and building on the server"
  ssh "$TREKKER_DEPLOY_HOST" \
    STAGING_DIR="$STAGING_DIR" \
    CURRENT_DIR="$CURRENT_DIR" \
    REMOTE_PATH="$REMOTE_PATH" \
    'bash -s' << 'EOF'
set -Eeuo pipefail
export PATH="$REMOTE_PATH:$PATH"
command -v pnpm >/dev/null 2>&1 || { echo "❌ ERROR: pnpm not found on the server" >&2; exit 1; }
command -v pm2  >/dev/null 2>&1 || { echo "❌ ERROR: pm2 not found on the server" >&2; exit 1; }

cd "$STAGING_DIR"

# Nothing to carry forward: the front has no environment. Behind nginx the API
# is same-origin under /api/, so there is nothing to point it at.
# --filter keeps the API's dependencies out of the front's install.
# --no-prod rather than --prod=false since TRE-145: pnpm 12's CLI takes no
# value for --prod, and refuses the whole command rather than ignoring it.
pnpm install --frozen-lockfile --filter ./front --no-prod
pnpm --filter ./front build
EOF

  log "➡️  Atomic release switch"
  ssh "$TREKKER_DEPLOY_HOST" \
    CURRENT_DIR="$CURRENT_DIR" \
    BACKUP_DIR="$BACKUP_DIR" \
    STAGING_DIR="$STAGING_DIR" \
    APP_SUBDIR="$APP_SUBDIR" \
    'bash -s' << 'EOF'
set -Eeuo pipefail
[ -d "$STAGING_DIR/$APP_SUBDIR/.next" ] || { echo "❌ ERROR: build output missing in staging" >&2; exit 1; }
rm -rf "$BACKUP_DIR"
[ -d "$CURRENT_DIR" ] && mv "$CURRENT_DIR" "$BACKUP_DIR"
cp -a "$STAGING_DIR" "$CURRENT_DIR"
echo "✅ New front release activated"
EOF

  SWITCH_DONE="true"

  log "➡️  Reloading pm2"
  remote_pm2_reload

  log "➡️  Verifying the front answers"
  ssh "$TREKKER_DEPLOY_HOST" \
    FRONT_PORT="$TREKKER_FRONT_PORT" \
    'bash -s' << 'EOF'
set -Eeuo pipefail
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$FRONT_PORT/" || true)
  if [ "$code" = "200" ] || [ "$code" = "307" ] || [ "$code" = "308" ]; then
    echo "✅ front answered $code"
    exit 0
  fi
  sleep 2
done
echo "❌ ERROR: front did not answer after 20s (last code: ${code:-none})" >&2
exit 1
EOF

  trap - ERR

  write_deploy_log "$ZEUS_ROLE" || log "⚠️  Deploy changelog update skipped (non-fatal)"
  zeus_report "success" || log "⚠️  The deploy registry was not told about this deploy (non-fatal)"

  log "✅ Front deployed on port $TREKKER_FRONT_PORT"
  log "ℹ️  Previous version: $BACKUP_DIR"
  log "ℹ️  Releases: $RELEASES_DIR"
  log "ℹ️  Rollback with: ./deploy-front.sh rollback"
}

rollback() {
  log "↩️  Manual rollback"

  # Reported for the same reason an automatic one is: it changes what is live.
  # It ships no commits and names no release — what it restores is whatever was
  # in the backup directory, and this script never learns its name.
  ZEUS_ROLE="front"
  ZEUS_STARTED_AT=$(date -u +%FT%TZ)
  ZEUS_STARTED_EPOCH=$(date +%s)
  ZEUS_REPORT_COMMITS="false"

  if ! remote_rollback; then
    zeus_report "failed" "manual rollback failed — the box needs looking at" || true
    die "Rollback failed. Check the server."
  fi
  remote_pm2_reload
  zeus_report "rolled_back" "manual rollback — the previous release is live again" || true
  log "✅ Previous front version is live again"
}

case "${1:-deploy}" in
  deploy) deploy ;;
  rollback) rollback ;;
  *) echo "Usage: $0 [deploy|rollback]"; exit 1 ;;
esac
