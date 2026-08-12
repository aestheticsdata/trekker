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

REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
API_ROOT="$TREKKER_REMOTE_ROOT"

# The deployed unit is the whole pnpm workspace, not just nest-api/.
#
# pfa and bkmk ship one package because each of their halves is an independent
# pnpm root with its own lockfile. Trekker is a single workspace, so the
# lockfile and the workspace manifest live at the repo root — send only
# nest-api/ and `pnpm install --frozen-lockfile` has nothing to work from.
#
#   $NEST_DIR   the workspace root on the server
#   $APP_DIR    the API package inside it, which is what PM2 runs
NEST_DIR="$API_ROOT/api"
APP_DIR="$NEST_DIR/nest-api"
NEST_BACKUP_DIR="$API_ROOT/api.bak"
NEST_RELEASES_DIR="$API_ROOT/api-releases"
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
    REMOTE_PATH="$REMOTE_PATH" \
    'bash -s' << 'EOF'
set -Eeuo pipefail
export PATH="$REMOTE_PATH:$PATH"
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
  require_clean_tree
  # Before the ERR trap below, and before anything reaches the server: a failing
  # check must read as "nothing was uploaded", not as a deploy that rolled back.
  run_preflight_checks
  compute_release_metadata
  zeus_init "api"

  local NEST_RELEASE_REMOTE="$NEST_RELEASES_DIR/$RELEASE_NAME"
  local SWITCH_DONE="false"

  on_error() {
    log "❌ ERROR: API deployment failed at line $1"
    if [[ "$SWITCH_DONE" == "true" ]]; then
      log "↩️  Auto rollback: restoring previous API"
      if remote_rollback; then
        log "✅ Auto rollback succeeded — reloading pm2"
        restart_pm2 || log "❌ pm2 reload after rollback failed, check the server"
        # `rolled_back`, not `failed` — the distinction is the whole reason Zeus
        # has three statuses: the deploy did fail, and the box is serving
        # exactly what it served before.
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

  # From the repo root: the lockfile, pnpm-workspace.yaml and every package's
  # package.json have to be present or --frozen-lockfile refuses to run.
  log "➡️  Syncing workspace sources"
  rsync -az --delete \
    --exclude=".git" \
    --exclude="node_modules" \
    --exclude="dist" \
    --exclude=".next" \
    --exclude="out" \
    --exclude="generated" \
    --exclude=".env" \
    --exclude="deploy.env" \
    --exclude=".DS_Store" \
    --exclude="ecosystem.config.js" \
    "$REPO_ROOT/" "$TREKKER_DEPLOY_HOST:$NEST_RELEASE_REMOTE/"

  # The PM2 config lives above the app directory so it survives the release
  # swap, which is why it is copied separately rather than left where rsync put
  # it. It holds no secrets — see the file itself.
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

# Nothing to carry forward into the release: configuration lives in
# ecosystem.config.js at $API_ROOT, which sits outside the directory being
# swapped and so survives on its own.

rm -rf "$NEST_BACKUP_DIR"
[ -d "$NEST_DIR" ] && mv "$NEST_DIR" "$NEST_BACKUP_DIR"
mv "$NEST_RELEASE_REMOTE" "$NEST_DIR"
echo "✅ New API release activated"
EOF

  SWITCH_DONE="true"

  log "➡️  Installing and building on the server"
  ssh "$TREKKER_DEPLOY_HOST" \
    NEST_DIR="$NEST_DIR" \
    APP_DIR="$APP_DIR" \
    REMOTE_PATH="$REMOTE_PATH" \
    'bash -s' << 'EOF'
set -Eeuo pipefail
export PATH="$REMOTE_PATH:$PATH"
# This IS production. Without it, prisma.config.ts's loadEnv() thinks it is in
# development and demands the dev ecosystem.config.js, which rightly does not
# exist inside the deployed package.
export NODE_ENV=production
command -v pnpm >/dev/null 2>&1 || { echo "❌ ERROR: pnpm not found on the server" >&2; exit 1; }
cd "$NEST_DIR"
# --prod=false explicitly: the build needs the Prisma CLI and the Nest CLI,
# which are devDependencies, and NODE_ENV=production would otherwise skip them.
# --filter keeps the front's dependencies out of this install.
pnpm install --frozen-lockfile --filter ./nest-api --prod=false
pnpm --filter ./nest-api build
EOF

  # Migrations run against the new code, before pm2 serves it. `migrate deploy`
  # only applies what is already in the repo — it never generates, never resets
  # and never prompts, which is what makes it the production verb.
  #
  # MySQL DDL is not transactional: a migration that fails midway leaves the
  # database part-applied, and the code rollback below cannot undo that. Check
  # `prisma migrate status` before re-running.
  log "➡️  Applying migrations"
  ssh "$TREKKER_DEPLOY_HOST" \
    APP_DIR="$APP_DIR" \
    API_ROOT="$API_ROOT" \
    REMOTE_PATH="$REMOTE_PATH" \
    'bash -s' << 'EOF'
set -Eeuo pipefail
export PATH="$REMOTE_PATH:$PATH"
# Same reason as the build step: loadEnv() must be a no-op here.
export NODE_ENV=production
cd "$APP_DIR"

# This runs outside PM2, so it does not inherit PM2's environment. Rather than
# keep a second copy of DATABASE_URL in a .env beside it — two values that must
# agree, with nothing checking that they do — read it out of the same ecosystem
# file PM2 uses. A migration applied to one database while the app talks to
# another is not a failure you notice quickly.
DATABASE_URL=$(node -e "
  const url = require('$API_ROOT/ecosystem.config.js').apps[0].env_production.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL missing from ecosystem.config.js'); process.exit(1); }
  process.stdout.write(url);
")
export DATABASE_URL

pnpm exec prisma migrate deploy
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

  write_deploy_log "$ZEUS_ROLE" || log "⚠️  Deploy changelog update skipped (non-fatal)"
  zeus_report "success" || log "⚠️  Zeus was not told about this deploy (non-fatal)"

  log "✅ API deployed on port $TREKKER_API_PORT"
  log "ℹ️  Previous version: $NEST_BACKUP_DIR"
  log "ℹ️  Rollback with: ./deploy-api.sh rollback"
}

rollback() {
  log "↩️  Manual rollback"

  # Reported for the same reason an automatic one is: it changes what is live,
  # and Zeus's whole claim is to know which build each service is serving. It
  # ships no commits and names no release — what it restores is whatever was in
  # the backup directory, and this script never learns its name.
  ZEUS_ROLE="api"
  ZEUS_STARTED_AT=$(date -u +%FT%TZ)
  ZEUS_STARTED_EPOCH=$(date +%s)
  ZEUS_REPORT_COMMITS="false"

  if ! remote_rollback; then
    zeus_report "failed" "manual rollback failed — the box needs looking at" || true
    die "Rollback failed. Check the server."
  fi
  restart_pm2
  zeus_report "rolled_back" "manual rollback — the previous release is live again" || true
  log "✅ Previous API version is live again"
}

case "${1:-deploy}" in
  deploy) deploy ;;
  rollback) rollback ;;
  *) echo "Usage: $0 [deploy|rollback]"; exit 1 ;;
esac
