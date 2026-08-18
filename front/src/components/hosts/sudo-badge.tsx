"use client";

import { useAuth } from "@auth/context/AuthContext";
import { SudoModal } from "@components/hosts/sudo-modal";
import { useToast } from "@components/ui/toast";
import { Tooltip } from "@components/ui/tooltip";
import { SUDO_INK, SUDO_SURFACE } from "@helpers/sudo";
import { dropSudo, formatWindow } from "@lib/api/sudo";
import { QUERY_KEYS } from "@lib/query/keys";
import { useSudoWindow } from "@lib/query/use-sudo";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { HostView } from "@lib/api/hosts";

/**
 * The sudo state of the host the panes are pointed at (TRE-29 §4).
 *
 * The mockup draws this as one switch in a user menu, which the shipped design
 * cannot use as drawn: a window belongs to one `(session, host)` pair, and a
 * single global toggle would be claiming something about a fleet that is only
 * ever true of one machine. So it rides beside the host chip instead — the one
 * place in the chrome that already names *which* host everything else is about
 * — and takes the mockup's language with it: `$` while closed, `#` in warning
 * amber while open, with the time left beside it.
 *
 * It owns its own ticking so that a second passing repaints a chip rather than
 * the explorer. Everything above it re-renders when the window opens or closes
 * and not once in between.
 */
export function SudoBadge({ host }: { host: HostView }) {
  const { csrfToken } = useAuth();
  const queryClient = useQueryClient();
  const { push } = useToast();

  const [asking, setAsking] = useState(false);
  const { open, remainingMs } = useSudoWindow(host.id);

  const drop = useMutation({
    mutationFn: () => dropSudo(host.id, csrfToken),
    throwOnError: false,
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.HOSTS] });
      // Silent when there was nothing to close. The route is idempotent so the
      // button may lose a race with the expiry timer, and a toast announcing
      // that a window nobody had was closed is noise about a non-event.
      if (result.wasOpen) push({ tone: "info", message: `sudo closed on ${host.label}`, detail: "prompts show $" });
    },
    onError: () => push({ tone: "danger", message: `Could not close the sudo window on ${host.label}` }),
  });

  return (
    <>
      <Tooltip
        content={
          open ? `Drop sudo on ${host.label} — ${formatWindow(remainingMs)} left` : `Elevate with sudo on ${host.label}`
        }
      >
        <button
          type="button"
          aria-pressed={open}
          // Named explicitly, because the visible text cannot do it. The `#` is
          // decorative to a screen reader and the countdown beside it is a bare
          // `14:32` — a control whose entire announced name is a clock.
          aria-label={
            open
              ? `Drop sudo on ${host.label}, ${formatWindow(remainingMs)} left`
              : `Elevate with sudo on ${host.label}`
          }
          onClick={() => (open ? drop.mutate() : setAsking(true))}
          className={`flex h-5.5 flex-none items-center gap-1.25 rounded-sm border px-2 font-mono text-xs ${
            open
              ? `border-warning ${SUDO_SURFACE} ${SUDO_INK} font-medium`
              : "border-line-strong text-ink-faint hover:text-warning hover:border-warning"
          }`}
        >
          {/* The prompt character, which is the whole indicator: `#` is what a
              root shell shows, and anyone who would care already reads it
              faster than they would read the word. */}
          <span aria-hidden>{open ? "#" : "$"}</span>
          <span>{open ? formatWindow(remainingMs) : "sudo"}</span>
        </button>
      </Tooltip>

      {asking && (
        <SudoModal
          host={host}
          onClose={() => setAsking(false)}
        />
      )}
    </>
  );
}
