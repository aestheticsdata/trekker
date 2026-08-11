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
#
# Allowlists are tested against the MATCH, never the line. Testing the line is
# how a guard quietly stops working: one placeholder anywhere on a line excuses
# every real value beside it, so a sentence contrasting the mandated placeholder
# with a real target passes as a single allowlisted line — and contrasting the
# two is exactly what such a sentence is for.
#
# This file cannot illustrate that with a literal, which is the same discipline
# it enforces: a made-up hostname is still hostname-shaped, and gitleaks reads
# .githooks/ even though pre-commit excludes it from its own greps. That
# asymmetry is deliberate — the two layers cover each other here.

# scan_infra <text>
#
# Prints a report for every shape found and returns 1 if anything matched.
# Takes the text as an argument rather than on stdin so the caller keeps stdin —
# hooks need it for the terminal.
scan_infra() {
  local text="$1"
  local found=0

  # _check <pattern> <what> [allow-on-match] [grep-flags] [allow-on-line]
  #
  # Extracts each match with its line number, drops the ones the allowlist
  # excuses, and reports what is left. `allow-on-line` is the rare escape for
  # a match that is only legitimate because of where it sits — it is tested
  # against the whole source line, so keep it narrow.
  _check() {
    local pattern="$1" what="$2" allow="${3:-}" flags="${4:--nEio}" allowline="${5:-}"
    local hits="" hit n m line

    while IFS= read -r hit; do
      [ -z "$hit" ] && continue
      n="${hit%%:*}"
      m="${hit#*:}"
      if [ -n "$allow" ] && printf '%s' "$m" | grep -qEi "$allow"; then
        continue
      fi
      # The window is the match's line and the two above it: a JSX prop and its
      # value are routinely three lines apart, and `placeholder={` on its own
      # line is the common formatting rather than the exception.
      if [ -n "$allowline" ]; then
        local from=$((n > 2 ? n - 2 : 1))
        line=$(printf '%s\n' "$text" | sed -n "${from},${n}p")
        printf '%s' "$line" | grep -qE "$allowline" && continue
      fi
      hits="${hits}      line ${n}: ${m}"$'\n'
    done < <(printf '%s\n' "$text" | grep $flags "$pattern" 2>/dev/null || true)

    if [ -n "$hits" ]; then
      printf '\n  \033[31m✗ %s\033[0m\n' "$what" >&2
      printf '%s' "$hits" | head -5 >&2
      found=1
    fi
  }

  # A user@host literal. The leading class is what keeps `owner/repo@ref` out:
  # every character inside a word is alphanumeric, so only the whole word can
  # start a match, and a `/` before it disqualifies it.
  # The host may not end on a dot or a hyphen, so a pair at the end of a
  # sentence matches `user@host` and not `user@host.` — otherwise the trailing
  # full stop defeats the `@host$` allowlist and the file that documents the
  # placeholder is refused for documenting it.
  _check '(^|[^/[:alnum:]._-])[a-z_][a-z0-9_-]*@[a-z0-9]([a-z0-9.-]*[a-z0-9])?' \
    "A user@host pair. Use deploy@host.example.com, or read it from deploy.env." \
    '@(([a-z0-9-]+\.)?example\.(com|org|net)|localhost|127\.0\.0\.1|host|[a-z0-9-]+\.(local|test|invalid))$|@(v?[0-9][0-9a-z.^~*+-]*|main|master|latest|sha256|\$.*)$'

  # A hostname with a real public suffix. Cheap here — the whole tracked tree
  # contains four, of which two are the mandated placeholder — and it is the
  # half of this repo's own leak that the user@host rule never saw, because the
  # hostname sat in a sentence with no user in front of it.
  #
  # A bare fleet alias like `a-b` is NOT detectable this way and never will be:
  # it is shaped exactly like an ordinary hyphenated word, and the only rule
  # that would catch it is a denylist of the real names, which is the leak it
  # would exist to prevent. That gap is covered by review, not by grep.
  _check '\b[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+\.(com|net|org|io|dev|app|sh|eu|fr|de|uk|us|cloud|xyz|me|info|biz|tech|systems|tools|works|zone|ovh|scw)\b' \
    "A hostname with a real public suffix. Use host.example.com." \
    '(^|\.)example\.(com|org|net)$|^(json\.)?schemastore\.org$|^(www\.)?(github|gitlab|npmjs|nodejs|anthropic)\.(com|org)$'

  # Case-SENSITIVE, alone among these: `/Users/` and `/home/` are the only
  # parts with a fixed spelling, and matching them loosely makes every
  # `/api/users/` route read as a macOS home directory — which refuses thirteen
  # tracked files and the README's own route table. A guard that blocks
  # ordinary work teaches --no-verify, which disables all of this at once.
  # The username stays both cases, so /Users/Someone is still caught.
  _check '(/Users/|/home/)[A-Za-z_][A-Za-z0-9_-]*' \
    "An absolute home directory from a real machine. Use /srv/app or /home/example-user." \
    '^/home/(example-user|user|deploy|debian|ubuntu|runner|node)$' \
    '-nEo'

  _check '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b' \
    "An IPv4 address. Only 127.0.0.1, 0.0.0.0 and the RFC 5737 ranges belong in this repo." \
    '^(127\.[0-9.]+|0\.0\.0\.0|255\.255\.[0-9.]+|10\.[0-9.]+|192\.168\.[0-9.]+|172\.(1[6-9]|2[0-9]|3[01])\.[0-9.]+|192\.0\.2\.[0-9]+|198\.51\.100\.[0-9]+|203\.0\.113\.[0-9]+)$'

  # The line-level escape is for a PEM header shown to the user as a `placeholder`
  # prop, telling them what shape to paste. Real key material never arrives on
  # such a line — it is a header followed by base64 — and gitleaks' own default
  # rules cover the loaded gun properly. This rule is the fallback for when
  # gitleaks is not installed, so it stays blunt everywhere else.
  _check '(SHA256:[A-Za-z0-9+/]{43}|BEGIN [A-Z ]*PRIVATE KEY|ssh-(rsa|ed25519|dss) AAAA)' \
    "Key material or a host key fingerprint." \
    "" "-nEio" 'placeholder[=:]'

  return $found
}
