#!/usr/bin/env bash
# The shapes this repo refuses to publish, and the placeholders it mandates
# (TRE-5 §1). Sourced by pre-commit, which judges staged content, and by
# commit-msg, which judges the message — the leak that actually reached the
# public remote was in both.
#
# These are deliberately not gitleaks rules. gitleaks knows entropy and key
# formats; these know what went wrong here, which was a hostname in prose,
# carrying no entropy at all. They also run when gitleaks is not installed,
# and gitleaks does not read commit messages in the first place.

# scan_infra <text> <label-prefix>
#
# Prints a report for every shape found and returns 1 if anything matched.
# Reads the text as an argument rather than stdin so the caller keeps stdin —
# hooks need it for the terminal.
scan_infra() {
  local text="$1"
  local found=0
  local hits

  _check() {
    local pattern="$1" what="$2" allow="${3:-}"
    hits=$(printf '%s\n' "$text" | grep -nEi "$pattern" || true)
    [ -n "$allow" ] && hits=$(printf '%s\n' "$hits" | grep -vEi "$allow" || true)
    # A no-match leaves a single empty line behind, which is not a finding.
    hits=$(printf '%s\n' "$hits" | grep -v '^[[:space:]]*$' || true)
    if [ -n "$hits" ]; then
      printf '\n  \033[31m✗ %s\033[0m\n' "$what" >&2
      printf '%s\n' "$hits" | head -5 | sed 's/^/      /' >&2
      found=1
    fi
  }

  _check '(^|[^/[:alnum:]._-])[a-z_][a-z0-9_-]*@[a-z0-9][a-z0-9.-]*' \
    "A user@host pair. Use deploy@host.example.com, or read it from deploy.env." \
    '@(([a-z0-9-]+\.)?example\.(com|org|net)|localhost|127\.0\.0\.1|host\b|\$)|@v[0-9]|@(main|master|latest|sha256)\b|[a-z]+@[a-z0-9-]+\.(local|test|invalid)|(@types|@nestjs|@tanstack|@hookform|@prisma|@biomejs|@eslint|@testing|@components|@helpers|@lib|@schemas|@auth|@styles|@app|@config|@hosts|@users|@secrets|@redis|@database|@fs|@health|@infrastructure|@media|@container|@apply|@theme|@keyframes|@supports|@import|@param|@returns|@throws|@see)'

  _check '(/Users/|/home/)[a-z_][a-z0-9_-]*' \
    "An absolute home directory from a real machine. Use /srv/app or /home/example-user." \
    '/home/(example-user|user|deploy|debian|ubuntu|runner|node)\b'

  _check '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b' \
    "An IPv4 address. Only 127.0.0.1, 0.0.0.0 and the RFC 5737 ranges belong in this repo." \
    '\b(127\.[0-9.]+|0\.0\.0\.0|255\.255\.[0-9.]+|10\.[0-9.]+|192\.168\.[0-9.]+|172\.(1[6-9]|2[0-9]|3[01])\.[0-9.]+|192\.0\.2\.[0-9]+|198\.51\.100\.[0-9]+|203\.0\.113\.[0-9]+)\b'

  _check '(SHA256:[A-Za-z0-9+/]{43}|BEGIN [A-Z ]*PRIVATE KEY|ssh-(rsa|ed25519|dss) AAAA)' \
    "Key material or a host key fingerprint."

  return $found
}
