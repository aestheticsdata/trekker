#!/usr/bin/env bash
# TRE-20 §5: break each pre-deploy check in turn and confirm the deploy refuses.
#
# The gate is the only thing standing between a broken tree and the server now
# that there is no CI, so "it refuses on a failure" is a claim that has to be
# demonstrated rather than asserted. This breaks lint, typecheck, tests, build
# and the secret sweep one at a time and checks the refusal names the right one.
#
#   bash scripts/verify-deploy-gate.sh        (or: pnpm verify:gate)
#
# It calls run_preflight_checks directly rather than running a whole deploy —
# that the gate needs none of deploy.env is part of what is being checked, since
# a check that ran after the server was reachable would be a rollback trigger
# and not a gate.
#
# It writes a handful of deliberately broken files into the working tree and
# removes them again, including on interrupt. It touches nothing else, and
# nothing it writes is ever committed.

# Derived, never written down: this repo is public and an absolute path from
# a real machine is exactly what TRE-5 keeps out of it.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STUBS=$(mktemp -d)
PASS=0
FAIL=0

cleanup_files=()
restore() {
  for f in "${cleanup_files[@]}"; do rm -f "$f"; done
  cleanup_files=()
  rm -f "$REPO/.git/trekker-preflight"
}
trap 'restore; rm -rf "$STUBS"' EXIT

# One gate run, in its own bash so `die`'s exit cannot take this script with it.
gate() {
  ( cd "$REPO" && env "$@" bash -c '
      source scripts/deploy-common.sh
      run_preflight_checks
    ' ) > "$STUBS/out.txt" 2>&1
  echo $?
}

expect() {
  local label="$1" want_code="$2" want_text="$3" code
  code=$(gate "${@:4}")
  local text; text=$(cat "$STUBS/out.txt")

  if [ "$code" = "$want_code" ] && [[ "$text" == *"$want_text"* ]]; then
    PASS=$((PASS + 1))
    printf 'ok    %-34s exit=%s, said %s\n' "$label" "$code" "\"$want_text\""
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL  %-34s exit=%s (wanted %s), looking for %s\n' "$label" "$code" "$want_code" "\"$want_text\""
    printf '%s\n' "$text" | tail -12 | sed 's/^/        /'
  fi
  restore
}

echo "=== the gate, with each check broken in turn ==="

# The four broken-check cases have nothing to say about the sweep and should not
# pay for it, so they waive it. Case 1 runs it for real where it can — on a
# machine without gitleaks it is waived too, and case 7 is what proves that a
# missing scanner is a refusal rather than a pass.
SWEEP=(TREKKER_ALLOW_UNSCANNED=1)
if command -v gitleaks >/dev/null 2>&1; then
  SWEEP=()
else
  echo "note: gitleaks not installed — case 1 waives the history sweep"
fi

# 1. Nothing broken.
expect "everything passing" 0 "Pre-deploy checks passed" "${SWEEP[@]}"

# 2. lint — badly formatted but perfectly valid TypeScript, so biome is the only
#    one of the five that objects.
printf 'export const gateProbe    =     1;\n' > "$REPO/front/src/helpers/gate-probe.ts"
cleanup_files+=("$REPO/front/src/helpers/gate-probe.ts")
expect "lint broken" 1 "Pre-deploy check failed: lint" TREKKER_ALLOW_UNSCANNED=1

# 3. typecheck — formatted correctly, so lint passes first.
printf 'export const gateProbe: number = "not a number";\n' > "$REPO/front/src/helpers/gate-probe.ts"
cleanup_files+=("$REPO/front/src/helpers/gate-probe.ts")
expect "typecheck broken" 1 "Pre-deploy check failed: typecheck" TREKKER_ALLOW_UNSCANNED=1

# 4. tests — a false assertion passes both lint and typecheck.
# rootDir is src/, testRegex is *.spec.ts — a spec under test/ belongs to the
# db suite and `pnpm test` never sees it.
cat > "$REPO/nest-api/src/gate-probe.spec.ts" <<'SPEC'
describe('gate probe', () => {
  it('fails on purpose', () => {
    expect(1).toBe(2);
  });
});
SPEC
cleanup_files+=("$REPO/nest-api/src/gate-probe.spec.ts")
expect "tests broken" 1 "Pre-deploy check failed: tests" TREKKER_ALLOW_UNSCANNED=1

# 5. build — a page that throws while Next collects page data. Valid TS, well
#    formatted, no failing test: the build is the first thing to notice.
mkdir -p "$REPO/front/src/app/gate-probe"
cat > "$REPO/front/src/app/gate-probe/page.tsx" <<'PAGE'
throw new Error("gate probe: this page cannot be built");

export default function GateProbePage() {
  return null;
}
PAGE
cleanup_files+=("$REPO/front/src/app/gate-probe/page.tsx")
expect "build broken" 1 "Pre-deploy check failed: build" TREKKER_ALLOW_UNSCANNED=1
# Next leaves .next/types/validator.ts pointing at the removed route, and
# every later tsc --noEmit fails on a page that no longer exists.
rm -rf "$REPO/front/src/app/gate-probe" "$REPO/front/.next"

# 6. the sweep — a gitleaks on PATH that reports findings.
printf '#!/bin/sh\necho "gate probe: pretend leak"\nexit 1\n' > "$STUBS/gitleaks"
chmod +x "$STUBS/gitleaks"
expect "secret sweep broken" 1 "Pre-deploy check failed: secret sweep" PATH="$STUBS:$PATH"

# 7. With no scanner at all, it refuses rather than passing — and waives only
#    when told to, out loud. Tested against `preflight_scanner_available` rather
#    than a whole gate run: a PATH with no gitleaks on it has no pnpm either, and
#    this one function is the entire decision.
scanner_check() {
  local label="$1" want_code="$2" want_text="$3" code text
  text=$( cd "$REPO" && env PATH="/usr/bin:/bin" "${@:4}" bash -c '
      source scripts/deploy-common.sh
      preflight_scanner_available
    ' 2>&1 )
  code=$?
  if [ "$code" = "$want_code" ] && [[ "$text" == *"$want_text"* ]]; then
    PASS=$((PASS + 1)); printf 'ok    %-34s exit=%s, said %s\n' "$label" "$code" "\"$want_text\""
  else
    FAIL=$((FAIL + 1)); printf 'FAIL  %-34s exit=%s (wanted %s)\n%s\n' "$label" "$code" "$want_code" "$text"
  fi
}

scanner_check "no gitleaks, no override" 1 "gitleaks is not installed"
scanner_check "no gitleaks, waived aloud" 1 "history sweep SKIPPED" TREKKER_ALLOW_UNSCANNED=1

echo
echo "=== the marker that stops both halves running it twice ==="
head=$(git -C "$REPO" rev-parse HEAD)
marker="$REPO/.git/trekker-preflight"

check_marker() {
  local label="$1" contents="$2" want="$3" got
  printf '%s\n' "$contents" > "$marker"
  got=$( cd "$REPO" && bash -c '
      source scripts/deploy-common.sh
      preflight_already_passed "'"$head"'" && echo skip || echo run
    ' )
  if [ "$got" = "$want" ]; then
    PASS=$((PASS + 1)); printf 'ok    %-34s %s\n' "$label" "$got"
  else
    FAIL=$((FAIL + 1)); printf 'FAIL  %-34s %s (wanted %s)\n' "$label" "$got" "$want"
  fi
  rm -f "$marker"
}

check_marker "same commit, fresh"        "$head $(date +%s)"                 skip
check_marker "same commit, 31min old"    "$head $(( $(date +%s) - 1860 ))"   run
check_marker "different commit"          "0000000000000000000000000000000000000000 $(date +%s)" run
check_marker "garbage in the marker"     "nonsense"                          run

got=$( cd "$REPO" && bash -c '
    source scripts/deploy-common.sh
    preflight_already_passed "dirty" && echo skip || echo run
  ' )
if [ "$got" = "run" ]; then
  PASS=$((PASS + 1)); printf 'ok    %-34s %s\n' "dirty tree never skips" "$got"
else
  FAIL=$((FAIL + 1)); printf 'FAIL  %-34s %s (wanted run)\n' "dirty tree never skips" "$got"
fi

echo
echo "$PASS passed, $FAIL failed."
[ "$FAIL" -eq 0 ]
