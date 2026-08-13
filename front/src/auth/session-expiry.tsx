"use client";

import { useAuth } from "@auth/context/AuthContext";
import { LOGIN_PATH, SESSION_EXPIRED_PARAM } from "@auth/paths";
import { onUnauthorized } from "@lib/api/client";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * The session ending while nobody was looking (TRE-63).
 *
 * The tab refetches on focus, so a laptop opened two hours later asks for
 * everything at once and is refused everything at once. Without this the panes
 * settle on "listing failed" and stay there — a true sentence about the request
 * that says nothing about the reason, in front of an operator who is now one
 * click from filing a bug about a working app.
 *
 * Renders nothing. It exists to hold one subscription for as long as there is
 * something private on screen.
 *
 * Mounted by the private layout and nowhere else, so that it is not listening
 * at all while someone is typing a password. That placement is not what makes a
 * mistyped password safe, though — `credentialCheck` in the API client is, and
 * it has to be, because the endpoint that changes a password is session-guarded
 * and could one day be called from inside this tree. Two answers to the same
 * question, and only the other one holds in every case.
 */
export function SessionExpiry() {
  const router = useRouter();
  const { clearAuth } = useAuth();

  // A focus refetch is refused once per pane, plus the sidebar, plus the
  // activity strip. That is one redirect, not four.
  const handled = useRef(false);

  useEffect(() => {
    // Re-subscribing is idempotent — one slot, replaced by an equivalent
    // closure — so nothing here rests on these dependencies holding still
    // between renders, and the guard above is a ref for the same reason.
    return onUnauthorized(() => {
      if (handled.current) return;
      handled.current = true;

      // The provider outlives this navigation, so a user left in context would
      // be a signed-in app rendering a login screen.
      clearAuth();

      // replace, not push: a session that no longer exists must not be one Back
      // away, and the server guard would only bounce them here again.
      router.replace(`${LOGIN_PATH}?${SESSION_EXPIRED_PARAM}=1`);
    });
  }, [clearAuth, router]);

  return null;
}
