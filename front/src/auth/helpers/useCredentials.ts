"use client";

import { useAuth } from "@auth/context/AuthContext";
import { usePathname, useRouter } from "next/navigation";

import type { AuthResponse } from "@auth/interfaces/authTypes";

/** Where a signed-in session belongs. */
export const EXPLORER_PATH = "/";

/**
 * The one place a successful authentication becomes app state (TRE-15 §3).
 * Ported from a sibling app: put the user and the CSRF token into context, then leave
 * for the explorer unless we are already there.
 */
const useCredentials = () => {
  const router = useRouter();
  const pathname = usePathname();
  const { setAuthState } = useAuth();

  const setCredentials = (auth: AuthResponse) => {
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
