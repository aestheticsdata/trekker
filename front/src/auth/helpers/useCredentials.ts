"use client";

import { useAuth } from "@auth/context/AuthContext";
import { EXPLORER_PATH } from "@auth/paths";
import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";

import type { AuthResponse } from "@auth/interfaces/authTypes";

/**
 * The one place a successful authentication becomes app state (TRE-15 §3).
 * Ported from a sibling app: put the user and the CSRF token into context, then leave
 * for the explorer unless we are already there.
 */
const useCredentials = () => {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const { setAuthState } = useAuth();

  const setCredentials = (auth: AuthResponse) => {
    // The query client lives above the routes and outlives a session ending, so
    // an expired tab still holds the last account's listings, bookmarks and
    // hosts. Wiped here rather than when the session expired: doing it there
    // pulls the cache out from under a still-mounted explorer, whose observers
    // answer by refetching everything into the same refusal. This is the moment
    // it protects anything — the next account is about to arrive (TRE-63).
    //
    // Inactive only, which is the same set said precisely: the previous
    // session's data is by definition unobserved, its tree having unmounted on
    // the way here, while the page calling this may well be watching a query of
    // its own — `signupStatus` on the registration screen — that a blanket
    // clear would drop and refetch under a form the reader is still filling.
    queryClient.removeQueries({ type: "inactive" });

    setAuthState(auth.user, auth.csrfToken);
    if (pathname !== EXPLORER_PATH) {
      // replace, not push: the login screen must not be one Back away from a
      // signed-in session.
      router.replace(EXPLORER_PATH);
    }
  };

  return { setCredentials };
};

export default useCredentials;
