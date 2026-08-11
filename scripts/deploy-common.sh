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

  # Deploy reporting to Zeus (optional). These name the two files ON THE SERVER
  # that hold the ingest URL and the shared token, in the order Zeus's own API
  # resolves them — its pm2 ecosystem file first, its .env second. The values
  # are read on the box and used on the box: the token never travels, never
  # lands in this repo, and never appears on an ssh command line where `ps`
  # would show it. With neither file named, deploys work and go unreported.
  ZEUS_ECOSYSTEM_FILE="${TREKKER_ZEUS_ECOSYSTEM_FILE:-}"
  ZEUS_ENV_FILE="${TREKKER_ZEUS_ENV_FILE:-}"
  # Trekker's slug in Zeus's port registry. The app's public name, so unlike
  # the paths above it is safe as a committed default.
  ZEUS_APP_NAME="${TREKKER_ZEUS_APP_NAME:-trekker}"
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

  # Resolved once per run, in zeus_init, before anything writes — this very
  # function moves the marker at the end of a successful deploy, so reading it
  # again here after a redeploy would measure the range from the wrong base.
  # The report to Zeus counts its commits from the same value, which is the
  # other reason there is exactly one resolution.
  prev_hash="${ZEUS_BASE_HASH:-}"
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

# ---------------------------------------------------------------------------
# Deploy reporting to Zeus. The contract is Zeus/docs/reporting/README.md; the
# shape is spira's deploy scripts, which are the fleet's worked example. Three
# rules, none optional: reporting must never fail the deploy (every step is
# `|| true` and callers ignore the return value), fire-and-forget with a 2s
# timeout and no retries, and the payload travels as a FILE — commit messages
# contain quotes, backticks and `$`, so interpolating one into a shell command
# is either invalid JSON or a command substitution.
# ---------------------------------------------------------------------------

# The commit the previous deploy shipped — the base of this deploy's commit
# range, for both the changelog and the report. Marker on the server first, a
# TREKKER_SINCE override second, empty third — which both consumers read as
# "no baseline, fall back to the last ten commits".
resolve_base_hash() {
  local marker="$TREKKER_REMOTE_ROOT/deploy-logs/.last-$ZEUS_ROLE"
  local base
  base=$(ssh "$TREKKER_DEPLOY_HOST" "cat '$marker' 2>/dev/null || true" 2>/dev/null || true)
  [ -z "$base" ] && base="${TREKKER_SINCE:-}"

  # A hash this checkout does not have is no baseline at all — a shallow clone,
  # or a marker left by a deploy from a branch since rewritten.
  if [ -n "$base" ] && ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
    base=""
  fi

  printf '%s' "$base"
}

# Gathers everything the report carries, called right after
# compute_release_metadata — early, so a deploy that fails at its very first
# step still reports something true. Not local to deploy(): the failure path
# reads these from the ERR trap.
zeus_init() {
  ZEUS_ROLE="$1"
  ZEUS_STARTED_AT=$(date -u +%FT%TZ)
  ZEUS_STARTED_EPOCH=$(date +%s)
  ZEUS_RELEASE="${RELEASE_NAME:-}"
  ZEUS_BRANCH="${GIT_BRANCH_RAW:-}"
  ZEUS_COMMIT=$(git rev-parse HEAD 2>/dev/null || true)
  ZEUS_BASE_HASH=$(resolve_base_hash)
}

# Escape a value for a JSON string literal. Applied to every interpolated field
# rather than the ones that look risky, so nothing here needs re-deciding; a
# malformed payload would be answered 400 and, every error on this path being
# swallowed, would vanish with no symptom. Backslash first — the reverse order
# would escape the backslashes this step adds.
json_escape() {
  local s="$1"
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\t'/ }
  printf '%s' "$s"
}

# The commits this deploy ships, as a JSON array, newest first. With no
# baseline the last ten commits stand in for a range nobody can reconstruct —
# the same fallback the changelog uses. Messages are escaped in awk because it
# reads them a line at a time: `%s` is the subject line, so it cannot contain a
# newline, and splitting on the first two spaces is exact because neither a sha
# nor an ISO-8601 date contains one.
zeus_commits_json() {
  local -a range

  # A manual rollback restores a release rather than shipping one. Falling
  # through to the last-ten baseline would claim it delivered ten commits it
  # had nothing to do with.
  if [ "${ZEUS_REPORT_COMMITS:-true}" != "true" ]; then
    printf '[]'
    return 0
  fi

  if [ -n "${ZEUS_BASE_HASH:-}" ]; then
    range=("${ZEUS_BASE_HASH}..HEAD")
  else
    range=(-n 10 HEAD)
  fi

  git log --no-merges --pretty=format:'%H %aI %s' "${range[@]}" 2>/dev/null | awk '
    BEGIN { printf "["; first = 1 }
    NF >= 3 {
      sha = $1
      when = $2
      msg = substr($0, length(sha) + length(when) + 3)
      gsub(/\\/, "\\\\", msg)
      gsub(/"/, "\\\"", msg)
      gsub(/\t/, " ", msg)
      if (!first) printf ","
      printf "{\"sha\":\"%s\",\"authoredAt\":\"%s\",\"message\":\"%s\"}", sha, when, msg
      first = 0
    }
    END { printf "]" }'
}

# Tell Zeus what this deploy did: `zeus_report <success|failed|rolled_back> [summary]`.
#
# The POST happens on the deploy host over ssh rather than from here: the
# endpoint is loopback-only and Zeus's nginx denies it from outside the box. The
# URL and token are read there too — see load_deploy_config.
zeus_report() {
  local status="$1"
  local summary="${2:-}"
  local commits payload remote_payload duration

  if [ -z "$ZEUS_ECOSYSTEM_FILE" ] && [ -z "$ZEUS_ENV_FILE" ]; then
    log "zeus: not reported — TREKKER_ZEUS_ECOSYSTEM_FILE / TREKKER_ZEUS_ENV_FILE not set in deploy.env"
    return 0
  fi

  commits=$(zeus_commits_json 2>/dev/null || echo "[]")
  duration=$(( ($(date +%s) - ${ZEUS_STARTED_EPOCH:-$(date +%s)}) * 1000 ))
  payload=$(mktemp)
  remote_payload="/tmp/.zeus-deploy-report.$$.json"

  {
    printf '{"app":"%s","role":"%s","status":"%s"' \
      "$(json_escape "$ZEUS_APP_NAME")" "$(json_escape "$ZEUS_ROLE")" "$(json_escape "$status")"
    printf ',"startedAt":"%s","durationMs":%s' "$(json_escape "${ZEUS_STARTED_AT}")" "$duration"
    [ -n "${ZEUS_RELEASE:-}" ] && printf ',"release":"%s"' "$(json_escape "$ZEUS_RELEASE")"
    [ -n "${ZEUS_COMMIT:-}" ] && printf ',"commit":"%s"' "$(json_escape "$ZEUS_COMMIT")"
    [ -n "${ZEUS_BRANCH:-}" ] && printf ',"branch":"%s"' "$(json_escape "$ZEUS_BRANCH")"
    [ -n "$summary" ] && printf ',"summary":"%s"' "$(json_escape "$summary")"
    printf ',"commits":%s}' "$commits"
  } > "$payload"

  scp -q "$payload" "$TREKKER_DEPLOY_HOST:$remote_payload" || { rm -f "$payload"; return 0; }
  rm -f "$payload"

  ssh "$TREKKER_DEPLOY_HOST" \
    ZEUS_ECOSYSTEM_FILE="$ZEUS_ECOSYSTEM_FILE" \
    ZEUS_ENV_FILE="$ZEUS_ENV_FILE" \
    PAYLOAD="$remote_payload" \
    'bash -s' << 'EOF' || true
set -uo pipefail

cleanup() { rm -f "$PAYLOAD"; }
trap cleanup EXIT

# One setting, looked for in Zeus's pm2 ecosystem file first and its .env
# second. That order is not a preference, it is the order Zeus's own API
# resolves them: pm2 injects env_production before Nest starts, and dotenv does
# not overwrite a variable that is already there. Reading the .env alone would
# present a token the API is not validating against the day the files disagree
# — a 401 on every report and no other symptom.
#
# Neither value is ever defaulted. A fallback URL would put Zeus's port in this
# repo, the one place a port reassignment cannot rewrite — and since every
# error below is swallowed, a stale default would fail quietly and forever.
#
# `\042` and `\047` are the double and single quote, so a value written either
# way is unwrapped without this needing quotes of its own inside a heredoc.
read_setting() {
  local key="$1" value=""

  if [ -f "$ZEUS_ECOSYSTEM_FILE" ]; then
    value=$(sed -n "s/.*${key}: *['\"]\([^'\"]*\)['\"].*/\1/p" "$ZEUS_ECOSYSTEM_FILE" 2>/dev/null | tail -1)
  fi

  if [ -z "$value" ] && [ -f "$ZEUS_ENV_FILE" ]; then
    value=$(sed -n "s/^${key}=//p" "$ZEUS_ENV_FILE" 2>/dev/null | tail -1 | tr -d '\042\047')
  fi

  printf '%s' "$value"
}

url=$(read_setting ZEUS_DEPLOY_INGEST_URL)
token=$(read_setting ZEUS_INGEST_TOKEN)

if [ -z "$url" ] || [ -z "$token" ]; then
  echo "zeus: not reported — ZEUS_DEPLOY_INGEST_URL or ZEUS_INGEST_TOKEN found in neither" \
    "$ZEUS_ECOSYSTEM_FILE nor $ZEUS_ENV_FILE"
  exit 0
fi

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 \
  -X POST "$url" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $token" \
  --data-binary @"$PAYLOAD" || true)

# 202 is the contract. Anything else is worth one line in the deploy output and
# nothing more — a deploy that shipped and could not say so still shipped.
[ "$code" = "202" ] || echo "zeus: report not recorded (HTTP ${code:-none})"
EOF
}
