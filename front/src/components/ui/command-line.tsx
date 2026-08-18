"use client";

import { COMMAND_SURFACE, PROMPT_ELEVATED_INK, PROMPT_INK } from "@helpers/sudo";
import { useSudoWindow } from "@lib/query/use-sudo";

/**
 * The operation, written the way a terminal would write it — and the prompt
 * character that says who it will run as (TRE-29).
 *
 * Display only. Nothing in this application runs a shell, and this string is
 * assembled to be read rather than executed; it is here because an operator
 * reading `chmod -R 0755 /srv` decides faster and more accurately than one
 * reading a form.
 *
 * The mockup's rule for the prompt is carried over exactly: `$` in link blue
 * while the session is unelevated, `#` in warning amber while a sudo window is
 * open on this host. It is the same signal a root shell gives, and anyone who
 * would care about it reads it faster than they would read a sentence.
 *
 * **The command itself is never prefixed with `sudo`, deliberately.** Trekker
 * escalates as a fallback and never as a default: every entry is attempted as
 * the login user first, and only a refusal — `EACCES` or `EPERM` — is retried
 * as root. Writing `sudo chmod …` here would claim that a change across four
 * thousand entries runs as root, when in a tree with four root-owned files
 * exactly four of them do. So the prompt says the *window* is open, and the
 * note below says what that actually changes.
 */
export function CommandLine({
  hostId,
  command,
  className = "",
}: {
  /** Which host the operation is aimed at — the window is per host. */
  hostId: string;
  command: string;
  /** The box's own overflow behaviour, which differs per modal. */
  className?: string;
}) {
  const { host, open } = useSudoWindow(hostId);

  return (
    <>
      <div className={`${COMMAND_SURFACE} border-line border px-2.5 py-2 font-mono text-cmd/[1.6] ${className}`}>
        {/* Hidden from assistive technology: read aloud, `#` is "number sign",
            which says nothing. The note below carries the same fact in words,
            and the badge in the top bar carries it in the chrome. */}
        <span
          aria-hidden
          className={open ? PROMPT_ELEVATED_INK : PROMPT_INK}
        >
          {open ? "#" : "$"}
        </span>{" "}
        <span className="text-ink-muted">{command}</span>
      </div>

      {open && (
        <p className={`${PROMPT_ELEVATED_INK} mt-1.5 font-mono text-2xs/[1.6]`}>
          sudo is open on {host?.label ?? "this host"}. Entries {host?.username ?? "this account"} is refused on are
          retried as root; everything else runs unelevated, as it would with the window closed.
        </p>
      )}
    </>
  );
}
