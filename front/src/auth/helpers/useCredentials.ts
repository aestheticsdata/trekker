"use client";

import { useAuth } from "@auth/context/AuthContext";
import { EXPLORER_PATH } from "@auth/paths";
import { useRouter } from "next/navigation";

import type { AuthResponse } from "@auth/interfaces/authTypes";

/**
 * The one place a successful authentication becomes app state (TRE-15 §3).
 * Ported from a sibling app: put the user and the CSRF token into context, then
 * leave for the explorer.
 *
 * Nothing is cleared on the way in, and nothing needs to be (TRE-88). A session
 * that ends leaves by a hard navigation, which takes the query cache down with
 * the document, so the only way to reach the form that calls this is on a page
 * that has never held another account's data.
 *
 * `replace`, not `push`: the login screen has no business in the history of a
 * signed-in session, where Back would land on a form that bounces the reader
 * straight forward again.
 */
const useCredentials = () => {
  const router = useRouter();
  const { setAuthState } = useAuth();

  const setCredentials = (auth: AuthResponse) => {
    setAuthState(auth.user, auth.csrfToken);
    router.replace(EXPLORER_PATH);
  };

  return { setCredentials };
};

export default useCredentials;
