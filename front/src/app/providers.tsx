"use client";

import { AuthProvider } from "@auth/context/AuthContext";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { useState } from "react";

import type { AuthUser } from "@auth/interfaces/authTypes";

export default function Providers({
  children,
  initialUser = null,
  initialCsrfToken = null,
}: {
  children: React.ReactNode;
  // Seeded from the server render so a reload never flashes the login screen
  // before the session is known (TRE-15).
  initialUser?: AuthUser | null;
  initialCsrfToken?: string | null;
}) {
  // Unlike pfa, Trekker's data is a live filesystem: a listing goes stale the
  // moment anything writes to that directory, including from another session.
  // So a short staleTime and refetch on focus, with explicit invalidation after
  // every mutation on top (TRE-16).
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: true,
            staleTime: 10 * 1000,
            throwOnError: true,
          },
        },
      }),
  );

  return (
    <AuthProvider
      initialUser={initialUser}
      initialCsrfToken={initialCsrfToken}
    >
      <NuqsAdapter>
        <QueryClientProvider client={queryClient}>
          {children}
          <ReactQueryDevtools initialIsOpen={false} />
        </QueryClientProvider>
      </NuqsAdapter>
    </AuthProvider>
  );
}
