#!/usr/bin/env bash
# Deploys the Trekker front. Same shape as pfa's: rsync into a release
# directory, build on the server, atomic switch keeping the previous version as
# a backup, pm2 reload, automatic rollback if anything fails after the switch.
#
# Usage: ./deploy-front.sh [deploy|rollback]

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../scripts/deploy-common.sh
source "$SCRIPT_DIR/../scripts/deploy-common.sh"

load_deploy_config

WEB_ROOT="$TREKKER_REMOTE_ROOT"
CURRENT_DIR="$WEB_ROOT/public_html"
BACKUP_DIR="$WEB_ROOT/public_html.bak"
RELEASES_DIR="$WEB_ROOT/front-releases"
# Committed and rsynced with the rest of the front — it holds no secrets.
PM2_ECOSYSTEM_FILE="ecosystem.config.cjs"

remote_pm2_reload() {
  ssh "$TREKKER_DEPLOY_HOST" \
    CURRENT_DIR="$CURRENT_DIR" \
    PM2_ECOSYSTEM_FILE="$PM2_ECOSYSTEM_FILE" \
    REMOTE_PATH_EXPORT="$REMOTE_PATH_EXPORT" \
    'bash -s' << 'EOF'
set -Eeuo pipefail
eval "$REMOTE_PATH_EXPORT"
cd "$CURRENT_DIR"
[ -f "$PM2_ECOSYSTEM_FILE" ] || { echo "❌ ERROR: missing $CURRENT_DIR/$PM2_ECOSYSTEM_FILE" >&2; exit 1; }
pm2 startOrReload "$CURRENT_DIR/$PM2_ECOSYSTEM_FILE" --update-env
pm2 save
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

deploy() {
  cd "$SCRIPT_DIR"
  check_tree_state
  compute_release_metadata

  local STAGING_DIR="$RELEASES_DIR/$RELEASE_NAME"
  local SWITCH_DONE="false"

  on_error() {
    log "❌ ERROR: front deployment failed at line $1"
    if [[ "$SWITCH_DONE" == "true" ]]; then
      log "↩️  Auto rollback: restoring previous front"
      if remote_rollback; then
        remote_pm2_reload || true
        log "✅ Auto rollback succeeded"
      else
        log "❌ Auto rollback failed, manual intervention required"
      fi
    else
      log "ℹ️  No rollback needed: production was not modified yet"
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

  # The lockfile lives at the workspace root, so it ships alongside the front —
  # `pnpm install --frozen-lockfile` needs it and the workspace manifest.
  log "➡️  Uploading front sources"
  rsync -az --delete \
    --exclude ".git" \
    --exclude ".next" \
    --exclude "node_modules" \
    --exclude "out" \
    --exclude ".DS_Store" \
    --exclude "deploy-front.sh" \
    "$SCRIPT_DIR"/ "$TREKKER_DEPLOY_HOST:$STAGING_DIR/"

  log "➡️  Installing and building on the server"
  ssh "$TREKKER_DEPLOY_HOST" \
    STAGING_DIR="$STAGING_DIR" \
    CURRENT_DIR="$CURRENT_DIR" \
    REMOTE_PATH_EXPORT="$REMOTE_PATH_EXPORT" \
    'bash -s' << 'EOF'
set -Eeuo pipefail
eval "$REMOTE_PATH_EXPORT"
command -v pnpm >/dev/null 2>&1 || { echo "❌ ERROR: pnpm not found on the server" >&2; exit 1; }
command -v pm2  >/dev/null 2>&1 || { echo "❌ ERROR: pm2 not found on the server" >&2; exit 1; }

cd "$STAGING_DIR"

# Nothing to carry forward: the front has no environment. Behind nginx the API
# is same-origin under /api/, so there is nothing to point it at.
pnpm install --frozen-lockfile
pnpm build
EOF

  log "➡️  Atomic release switch"
  ssh "$TREKKER_DEPLOY_HOST" \
    CURRENT_DIR="$CURRENT_DIR" \
    BACKUP_DIR="$BACKUP_DIR" \
    STAGING_DIR="$STAGING_DIR" \
    'bash -s' << 'EOF'
set -Eeuo pipefail
[ -d "$STAGING_DIR/.next" ] || { echo "❌ ERROR: build output missing in staging" >&2; exit 1; }
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

  write_deploy_log "front" || log "⚠️  Deploy changelog update skipped (non-fatal)"

  log "✅ Front deployed on port $TREKKER_FRONT_PORT"
  log "ℹ️  Previous version: $BACKUP_DIR"
  log "ℹ️  Releases: $RELEASES_DIR"
  log "ℹ️  Rollback with: ./deploy-front.sh rollback"
}

rollback() {
  log "↩️  Manual rollback"
  remote_rollback || die "Rollback failed. Check the server."
  remote_pm2_reload
  log "✅ Previous front version is live again"
}

case "${1:-deploy}" in
  deploy) deploy ;;
  rollback) rollback ;;
  *) echo "Usage: $0 [deploy|rollback]"; exit 1 ;;
esac
