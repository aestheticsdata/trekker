"use client";

import { Tooltip } from "@components/ui/tooltip";

import type { HostView } from "@lib/api/hosts";

/**
 * A machine and a place on it, as one line: the host's colour dot, then
 * `label:path`.
 *
 * The path falls off the **left**, which is the pane's own breadcrumb rule and
 * matters most where this is drawn twice at once: two endpoints of a deep tree
 * share every leading segment, so an ellipsis at the end renders the source and
 * the destination as the same illegible string with an arrow between them. What
 * distinguishes them is the last few segments, so those are what survive.
 *
 * Done with `justify-end` in an overflow-hidden box rather than `truncate`,
 * because CSS has no head-side text-overflow — the same reason `Breadcrumb`
 * does it this way.
 *
 * Two callers, and the second is why this left `transfer-modal.tsx`: that modal
 * draws two of these with an arrow between them (TRE-24), and the upload modal
 * draws one and calls it the destination (TRE-125). The colour dot is the whole
 * point in both — a path alone does not say which machine it is on, and that is
 * precisely the question each modal exists to answer before anything moves.
 */
export function HostPath({ host, path }: { host: HostView | null; path: string }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      <span
        aria-hidden
        className="size-1.5 flex-none rounded-full"
        style={{ backgroundColor: host?.colour ?? "var(--color-ink-faint)" }}
      />
      <Tooltip content={host ? `${host.label}:${path}` : path}>
        <span className="flex min-w-0 flex-auto justify-end overflow-hidden">
          <span className="text-ink-muted flex-none font-mono text-cmd whitespace-nowrap">
            {host ? `${host.label}:${path}` : path}
          </span>
        </span>
      </Tooltip>
    </span>
  );
}
