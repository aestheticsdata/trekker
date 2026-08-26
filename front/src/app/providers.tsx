"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { useState } from "react";

/**
 * The providers that belong to the document rather than to a session (TRE-89).
 *
 * `AuthProvider` used to sit above these, seeded from the root layout. It lives
 * in each group layout now, and these two stay here because they have to
 * outlive a move between the groups: a `QueryClient` built inside a group
 * layout would be rebuilt every time the app crossed from `(public)` to
 * `(private)` and take the cache down with it — and the public tree would need
 * one of its own regardless, since the sign-up screen asks the API whether
 * registration is still open.
 *
 * The auth context is a descendant of these now rather than an ancestor.
 * Nothing notices: it holds two state values and reads neither.
 */
export default function Providers({ children }: { children: React.ReactNode }) {
  // Unlike its siblings, Trekker's data is a live filesystem: a listing goes stale the
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
    <NuqsAdapter>
      <QueryClientProvider client={queryClient}>
        {children}
        <ReactQueryDevtools initialIsOpen={false} />
      </QueryClientProvider>
    </NuqsAdapter>
  );
}
