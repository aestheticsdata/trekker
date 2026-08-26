"use client";

import { useAuth } from "@auth/context/AuthContext";
import { LOGIN_PATH } from "@auth/paths";
import { ContextMenu } from "@components/ui/context-menu";
import { useToast } from "@components/ui/toast";
import { ApiError } from "@lib/api/client";
import { logout } from "@lib/api/users";
import { useRef, useState } from "react";

import type { MenuRow } from "@components/shell/actions";
import type { Point } from "@helpers/menu";

/**
 * Who is signed in, and the way out (TRE-90).
 *
 * In the top bar's right corner rather than in the sidebar, which is `hidden`
 * below `panes:` — the one control that ends a session cannot be the one that
 * disappears at 899px — and rather than in the status bar, which is 24px of
 * `text-2xs` already carrying a clipboard `✕` and the size stepper.
 *
 * It reuses `ContextMenu` for the reason that component's own note gives: it
 * takes a `MenuRow` precisely so a menu that is not about a selection can have
 * this panel, this keyboard and this disabled treatment instead of a second
 * menu written beside it. There is no dropdown library in this app and this
 * ticket does not add one.
 *
 * One row today. A change-password form does not exist yet, and the rule this
 * app follows is the sidebar's — hide a panel rather than fake it — so there is
 * no greyed-out promise here. The menu grows a second row the day it lands.
 */

/** The one id this menu dispatches. Local to the file: no registry has it. */
const SIGN_OUT = "account.signOut";

/**
 * How long a click is ignored after the panel closes.
 *
 * `ContextMenu` closes on an outside pointer press, and that press is also the
 * one that lands on this chip — so without this, clicking the open chip closes
 * the panel and immediately reopens it, and the menu cannot be dismissed by the
 * control that opened it.
 */
const REOPEN_GRACE_MS = 250;

export function AccountMenu({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  const { user, csrfToken } = useAuth();
  const { push } = useToast();
  /** Where the menu is, or null when it is closed. */
  const [point, setPoint] = useState<Point | null>(null);
  const [leaving, setLeaving] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const closedAt = useRef(0);

  // The private layout redirects without a session, so this is only ever null
  // in the moment a type demands and never in the product.
  if (!user) return null;

  const open = (next: Point | null) => {
    setPoint(next);
    onOpenChange?.(next !== null);
  };

  const close = () => {
    closedAt.current = performance.now();
    open(null);
    // `ContextMenu` takes focus into its own panel and never gives it back.
    // Its usual trigger is a right-click, which has nowhere to return to; this
    // one is a Tab stop, so ⎋ has to land back on it rather than on the body.
    trigger.current?.focus();
  };

  /**
   * The request first, then the door.
   *
   * The POST needs the CSRF token this context is holding, so it goes before
   * anything drops it — and nothing drops it. `clearAuth` is not called and
   * neither is `queryClient.clear()`: the navigation below is a hard one, and
   * `lib/api/client.ts` already states what that means — it discards the auth
   * context, the query cache and this React tree, and re-runs the server guard.
   * Emptying them by hand first would only repaint the explorer with a null
   * account for one frame before the browser leaves. The same call a sibling
   * app makes, for the same stated reason.
   *
   * A failure keeps us here, with the door still offered. Most of the fleet
   * leaves regardless, because stranding someone on a screen they asked to
   * leave is worse — but this app holds SSH credentials for a fleet, and a
   * failed logout leaves both the session (rolling, an hour) and any sudo
   * window open on it. Saying so is the honest answer; the toast's own action
   * is how somebody who wants out anyway still gets out.
   */
  const signOut = async () => {
    setLeaving(true);
    try {
      await logout(csrfToken);
    } catch (error) {
      setLeaving(false);
      push({
        tone: "danger",
        message: "Could not sign out",
        detail: error instanceof ApiError ? error.message : "The API did not answer.",
        action: {
          label: "Leave anyway",
          title: "Return to the sign-in screen. The session stays open until it expires.",
          onClick: () => window.location.replace(LOGIN_PATH),
        },
      });
      return;
    }

    window.location.replace(LOGIN_PATH);
  };

  const rows: readonly MenuRow[] = [
    // Not `danger`. Signing out loses nothing and one more sign-in undoes it —
    // and this menu's red is `rm`'s, which should never come to look routine.
    { id: SIGN_OUT, label: "Sign out" },
  ];

  return (
    <>
      {/* A rule between the two, as the one further left separates the host
          from the views: ⌘K is a thing this app does, and the chip after it is
          who is doing it. Rendered here rather than in the bar so that it
          cannot be left behind by the guard above. */}
      <span
        aria-hidden
        className="bg-line h-4 w-px flex-none"
      />

      <button
        ref={trigger}
        type="button"
        // `onClick`, not `onPointerDown`: ↵ and Space raise a click and never a
        // pointer event, and the only control that ends a session has to be
        // reachable from the keyboard that reached everything else.
        onClick={(event) => {
          if (performance.now() - closedAt.current < REOPEN_GRACE_MS) return;
          const box = event.currentTarget.getBoundingClientRect();
          // `box.right`, so `placeMenu`'s per-axis flip right-aligns the panel
          // under a chip that is itself against the right edge.
          open({ x: box.right, y: box.bottom + 3 });
        }}
        aria-haspopup="menu"
        aria-expanded={point !== null}
        className="border-line-strong text-ink-muted hover:bg-raised flex h-5.5 max-w-40 items-center gap-1.5 rounded-sm border px-2 font-mono text-xs"
      >
        {/* The address, not a name: it is what was typed to get in, and it is
            what tells two accounts apart on a shared machine. Truncated rather
            than shortened to the local part, so the domain survives where there
            is room for it. */}
        <span className="truncate">{leaving ? "signing out…" : user.email}</span>
      </button>

      {point && (
        <ContextMenu
          point={point}
          label={user.email}
          rows={rows}
          onClose={close}
          onChoose={(id) => {
            close();
            if (id === SIGN_OUT) void signOut();
          }}
        />
      )}
    </>
  );
}
