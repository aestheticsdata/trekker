#!/usr/bin/env bash
# Shared by deploy-api.sh and deploy-front.sh. Sourced, never executed directly.
#
# Everything that names real infrastructure comes from deploy.env, which is not
# committed — this repo is public (TRE-5). The scripts themselves stay generic.

set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() {
  echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

die() {
  echo "❌ ERROR: $*" >&2
  exit 1
}

# Loads deploy.env and checks every required variable is present. Failing here,
# before anything touches the server, is the whole point.
load_deploy_config() {
  local config="$REPO_ROOT/deploy.env"

  [ -f "$config" ] || die "Missing $config — copy deploy.env.example and fill it in."

  set -a
  # shellcheck source=/dev/null
  source "$config"
  set +a

  local missing=()
  for var in TREKKER_DEPLOY_HOST TREKKER_REMOTE_ROOT TREKKER_FRONT_PORT TREKKER_API_PORT; do
    [ -n "${!var:-}" ] || missing+=("$var")
  done

  if [ ${#missing[@]} -gt 0 ]; then
    die "deploy.env is missing: ${missing[*]}"
  fi

  if [[ "$TREKKER_DEPLOY_HOST" == *"host.example.com"* ]]; then
    die "deploy.env still holds the placeholder host. Set TREKKER_DEPLOY_HOST to your server."
  fi

  # The VALUE only, never a whole `export PATH=...` statement.
  #
  # These are handed to ssh as `ssh host VAR=value 'bash -s'`, and ssh flattens
  # its arguments into one command string that the remote shell re-parses. A
  # value containing a space is split there: `REMOTE_PATH_EXPORT=export` and
  # `PATH=...` become two separate assignments, and the later `eval "$VAR"` runs
  # a bare `export`, which prints the entire environment instead of setting
  # anything. A colon-separated path list has no spaces, so it survives intact.
  REMOTE_PATH="${TREKKER_REMOTE_PATH:-/usr/local/bin:/usr/bin:/bin:/usr/sbin}"
}

# Release naming, shared so the API and front folders sort together by date.
compute_release_metadata() {
  GIT_HASH=$(git rev-parse --short HEAD 2>/dev/null || echo "no-git")
  GIT_BRANCH_RAW=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "no-branch")
  GIT_BRANCH=${GIT_BRANCH_RAW//\//-}
  GIT_BRANCH=${GIT_BRANCH// /_}
  RELEASE_NAME="release-$(date +'%Y%m%d-%H%M%S')-${GIT_BRANCH}-${GIT_HASH}"
}

# Refuses to deploy a dirty or unpushed tree. pfa does not check this; it is
# cheap insurance against "which commit is actually live?" being unanswerable,
# and the deploy changelog below is only meaningful if HEAD is real.
require_clean_tree() {
  if [ -n "$(git status --porcelain)" ]; then
    die "Working tree is dirty. Commit or stash before deploying, or re-run with TREKKER_ALLOW_DIRTY=1."
  fi
}

check_tree_state() {
  [ "${TREKKER_ALLOW_DIRTY:-0}" = "1" ] || require_clean_tree
}

# Prepends this deploy's commits (and TRE tickets) to the changelog kept on the
# server. Always called as `write_deploy_log || log ...`: a changelog hiccup must
# never fail, or roll back, an otherwise successful deploy.
write_deploy_log() {
  local app="$1"
  local log_dir="$TREKKER_REMOTE_ROOT/deploy-logs"
  local log_file="$log_dir/deploys-$app.txt"
  local marker="$log_dir/.last-$app"
  local full_hash when prev_hash tickets commits entry_tmp
  local -a range

  full_hash=$(git rev-parse HEAD)
  when=$(date +'%Y-%m-%d %H:%M:%S')

  prev_hash=$(ssh "$TREKKER_DEPLOY_HOST" "cat '$marker' 2>/dev/null || true")
  [ -z "$prev_hash" ] && prev_hash="${TREKKER_SINCE:-}"
  if [ -n "$prev_hash" ] && ! git cat-file -e "${prev_hash}^{commit}" 2>/dev/null; then
    prev_hash=""
  fi
  if [ -n "$prev_hash" ]; then
    range=("${prev_hash}..HEAD")
  else
    range=(-n 10 HEAD)
  fi

  # One git-log call captured into a variable: no `| grep -q` on a pipe git may
  # SIGPIPE, which would trip pipefail.
  commits=$(git log --no-merges --pretty=format:'  %h  %ad  %s' --date=short "${range[@]}")
  tickets=$(printf '%s\n' "$commits" \
    | grep -oiE 'TRE-[0-9]+' | tr 'a-z' 'A-Z' | sort -t- -k2,2n -u | paste -sd ',' - | sed 's/,/, /g' || true)

  entry_tmp=$(mktemp)
  {
    echo "=== $when · branch $GIT_BRANCH_RAW · deploy $GIT_HASH ==="
    [ -n "$tickets" ] && echo "Tickets: $tickets"
    [ -z "$prev_hash" ] && echo "  (first recorded deploy — baseline: last 10 commits, not full history)"
    if [ -n "$commits" ]; then
      printf '%s\n' "$commits"
    else
      echo "  (no new commit — redeploy of $GIT_HASH)"
    fi
    echo
  } > "$entry_tmp"

  # Commit messages travel as file content over scp, never interpolated into a
  # shell command — a commit message is attacker-adjacent input on a public repo.
  ssh "$TREKKER_DEPLOY_HOST" "mkdir -p '$log_dir'"
  scp -q "$entry_tmp" "$TREKKER_DEPLOY_HOST:$log_dir/.entry.tmp"
  ssh "$TREKKER_DEPLOY_HOST" \
    LOG_DIR="$log_dir" \
    LOG_FILE="$log_file" \
    MARKER="$marker" \
    FULL_HASH="$full_hash" \
    'bash -s' << 'EOF'
set -Eeuo pipefail
touch "$LOG_FILE"
cat "$LOG_DIR/.entry.tmp" "$LOG_FILE" > "$LOG_FILE.new"
mv "$LOG_FILE.new" "$LOG_FILE"
rm -f "$LOG_DIR/.entry.tmp"
printf '%s\n' "$FULL_HASH" > "$MARKER"
EOF
  rm -f "$entry_tmp"
}
