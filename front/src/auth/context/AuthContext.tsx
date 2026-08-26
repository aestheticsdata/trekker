"use client";

import { createContext, useContext, useState } from "react";

import type { AuthUser } from "@auth/interfaces/authTypes";

/**
 * Who is signed in, and the CSRF token that proves this tab is the one that
 * signed in (TRE-15 §3). Ported from a sibling app unchanged in shape.
 *
 * The token lives here and nowhere else — not in localStorage, not in a URL.
 * It is handed to the app by the server on sign-in and on every reload through
 * the session bootstrap, so there is nothing to persist on this side.
 */

interface AuthProviderProps {
  children: React.ReactNode;
  initialUser?: AuthUser | null;
  initialCsrfToken?: string | null;
}

interface AuthContextValue {
  user: AuthUser | null;
  csrfToken: string | null;
  setUser: (user: AuthUser | null) => void;
  setCsrfToken: (csrfToken: string | null) => void;
  setAuthState: (user: AuthUser, csrfToken: string | null) => void;
  clearAuth: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider = ({ children, initialUser = null, initialCsrfToken = null }: AuthProviderProps) => {
  // Seeded from the server render, which is what stops a reload flashing the
  // login screen before the session is known.
  const [user, setUser] = useState<AuthUser | null>(initialUser);
  const [csrfToken, setCsrfToken] = useState<string | null>(initialCsrfToken);

  const setAuthState = (nextUser: AuthUser, nextCsrfToken: string | null) => {
    setUser(nextUser);
    setCsrfToken(nextCsrfToken);
  };

  /**
   * Nothing calls this, and that is the design rather than an omission (TRE-90).
   *
   * Both ways out of a session leave by a hard navigation — the 401 caught in
   * `lib/api/client.ts`, and the account menu's sign-out — and that navigation
   * takes this provider down with the document. Emptying it first would only
   * repaint the explorer with a null account for one frame before the browser
   * leaves. It stays because this context's shape is shared with the rest of
   * the fleet, not because a caller is expected.
   */
  const clearAuth = () => {
    setUser(null);
    setCsrfToken(null);
  };

  const value: AuthContextValue = {
    user,
    csrfToken,
    setUser,
    setCsrfToken,
    setAuthState,
    clearAuth,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};
