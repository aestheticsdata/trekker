#!/usr/bin/env bash
# Deploys the Trekker API. Same shape as pfa's: rsync into a fresh release
# directory, atomic switch keeping the previous version as a backup, install and
# build on the server, pm2 reload, with automatic rollback if anything fails
# after the switch.
#
# Usage: ./deploy-api.sh [deploy|rollback]

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../scripts/deploy-common.sh
source "$SCRIPT_DIR/../scripts/deploy-common.sh"

load_deploy_config

API_ROOT="$TREKKER_REMOTE_ROOT"
NEST_DIR="$API_ROOT/nest-api"
NEST_BACKUP_DIR="$API_ROOT/nest-api.bak"
NEST_RELEASES_DIR="$API_ROOT/nest-api-releases"
ECOSYSTEM_FILE="$SCRIPT_DIR/ecosystem.config.js"

remote_rollback() {
  ssh "$TREKKER_DEPLOY_HOST" \
    NEST_DIR="$NEST_DIR" \
    NEST_BACKUP_DIR="$NEST_BACKUP_DIR" \
    API_ROOT="$API_ROOT" \
    'bash -s' << 'EOF'
set -Eeuo pipefail
cd "$API_ROOT"
[ -d "$NEST_BACKUP_DIR" ] || { echo "❌ ERROR: no backup at $NEST_BACKUP_DIR" >&2; exit 1; }
rm -rf "$NEST_DIR"
mv "$NEST_BACKUP_DIR" "$NEST_DIR"
echo "✅ API rollback done (restored from backup)"
EOF
}

restart_pm2() {
  ssh "$TREKKER_DEPLOY_HOST" \
    API_ROOT="$API_ROOT" \
    REMOTE_PATH_EXPORT="$REMOTE_PATH_EXPORT" \
    'bash -s' << 'EOF'
set -Eeuo pipefail
eval "$REMOTE_PATH_EXPORT"
cd "$API_ROOT"
command -v pm2 >/dev/null 2>&1 || { echo "❌ ERROR: pm2 not found on the server" >&2; exit 1; }
pm2 startOrReload ecosystem.config.js --env production --update-env
pm2 save
EOF
}

deploy() {
  cd "$SCRIPT_DIR"
  # Setup problems before readiness problems: "you haven't configured this" is a
  # different kind of failure from "you're not ready to ship", and hitting them
  # one at a time across two runs is needless.
  [ -f "$ECOSYSTEM_FILE" ] || die "Missing $ECOSYSTEM_FILE — copy ecosystem.config.example.js and fill it in. It is not committed."
  check_tree_state
  compute_release_metadata

  local NEST_RELEASE_REMOTE="$NEST_RELEASES_DIR/$RELEASE_NAME"
  local SWITCH_DONE="false"

  on_error() {
    log "❌ ERROR: API deployment failed at line $1"
    if [[ "$SWITCH_DONE" == "true" ]]; then
      log "↩️  Auto rollback: restoring previous API"
      if remote_rollback; then
        log "✅ Auto rollback succeeded — reloading pm2"
        restart_pm2 || log "❌ pm2 reload after rollback failed, check the server"
      else
        log "❌ Auto rollback failed, manual intervention required"
      fi
    else
      log "ℹ️  No rollback needed: production was not modified yet"
    fi
  }
  trap 'on_error $LINENO' ERR

  log "➡️  Preparing release directory"
  ssh "$TREKKER_DEPLOY_HOST" \
    NEST_RELEASES_DIR="$NEST_RELEASES_DIR" \
    NEST_RELEASE_REMOTE="$NEST_RELEASE_REMOTE" \
    API_ROOT="$API_ROOT" \
    'bash -s' << 'EOF'
set -Eeuo pipefail
mkdir -p "$API_ROOT" "$NEST_RELEASES_DIR"
rm -rf "$NEST_RELEASE_REMOTE"
mkdir -p "$NEST_RELEASE_REMOTE"
EOF

  log "➡️  Syncing API sources"
  rsync -az --delete \
    --exclude=".git" \
    --exclude="node_modules" \
    --exclude="dist" \
    --exclude=".env" \
    --exclude=".DS_Store" \
    --exclude="deploy-api.sh" \
    --exclude="ecosystem.config.js" \
    "$SCRIPT_DIR/" "$TREKKER_DEPLOY_HOST:$NEST_RELEASE_REMOTE/"

  log "➡️  Syncing ecosystem.config.js"
  scp -q "$ECOSYSTEM_FILE" "$TREKKER_DEPLOY_HOST:$API_ROOT/ecosystem.config.js"

  log "➡️  Atomic release switch"
  ssh "$TREKKER_DEPLOY_HOST" \
    NEST_DIR="$NEST_DIR" \
    NEST_BACKUP_DIR="$NEST_BACKUP_DIR" \
    NEST_RELEASE_REMOTE="$NEST_RELEASE_REMOTE" \
    API_ROOT="$API_ROOT" \
    'bash -s' << 'EOF'
set -Eeuo pipefail
cd "$API_ROOT"
[ -f "$NEST_RELEASE_REMOTE/package.json" ] || { echo "❌ ERROR: release looks empty" >&2; exit 1; }

# The API keeps its .env on the server: it holds the master key, and that never
# travels from a workstation.
if [ -f "$NEST_DIR/.env" ]; then
  cp "$NEST_DIR/.env" "$NEST_RELEASE_REMOTE/.env"
else
  echo "⚠️  No existing $NEST_DIR/.env — create it on the server before the first start" >&2
fi

rm -rf "$NEST_BACKUP_DIR"
[ -d "$NEST_DIR" ] && mv "$NEST_DIR" "$NEST_BACKUP_DIR"
mv "$NEST_RELEASE_REMOTE" "$NEST_DIR"
echo "✅ New API release activated"
EOF

  SWITCH_DONE="true"

  log "➡️  Installing and building on the server"
  ssh "$TREKKER_DEPLOY_HOST" \
    NEST_DIR="$NEST_DIR" \
    REMOTE_PATH_EXPORT="$REMOTE_PATH_EXPORT" \
    'bash -s' << 'EOF'
set -Eeuo pipefail
eval "$REMOTE_PATH_EXPORT"
command -v pnpm >/dev/null 2>&1 || { echo "❌ ERROR: pnpm not found on the server" >&2; exit 1; }
cd "$NEST_DIR"
rm -rf node_modules dist
pnpm install --frozen-lockfile --filter .
pnpm build
EOF

  log "➡️  Reloading pm2"
  restart_pm2

  # Fail the deploy if the thing that just shipped cannot answer. A deploy that
  # reports success while the API is down is the failure mode worth preventing.
  log "➡️  Verifying /api/health"
  ssh "$TREKKER_DEPLOY_HOST" \
    API_PORT="$TREKKER_API_PORT" \
    'bash -s' << 'EOF'
set -Eeuo pipefail
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if body=$(curl -fsS --max-time 5 "http://127.0.0.1:$API_PORT/api/health" 2>/dev/null); then
    echo "✅ health: $body"
    exit 0
  fi
  sleep 2
done
echo "❌ ERROR: API did not answer /api/health after 20s" >&2
exit 1
EOF

  trap - ERR

  write_deploy_log "api" || log "⚠️  Deploy changelog update skipped (non-fatal)"

  log "✅ API deployed on port $TREKKER_API_PORT"
  log "ℹ️  Previous version: $NEST_BACKUP_DIR"
  log "ℹ️  Rollback with: ./deploy-api.sh rollback"
}

rollback() {
  log "↩️  Manual rollback"
  remote_rollback || die "Rollback failed. Check the server."
  restart_pm2
  log "✅ Previous API version is live again"
}

case "${1:-deploy}" in
  deploy) deploy ;;
  rollback) rollback ;;
  *) echo "Usage: $0 [deploy|rollback]"; exit 1 ;;
esac
