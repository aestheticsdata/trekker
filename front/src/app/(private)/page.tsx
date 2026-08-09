"use client";

import { fetchHealth } from "@lib/api/health";
import { QUERY_KEYS } from "@lib/query/keys";
import { useQuery } from "@tanstack/react-query";

/**
 * Placeholder home. It exists to prove the vertical slice is wired — front
 * talks to API, Zod parses the response, TanStack Query holds it — and is
 * replaced wholesale by the dual-pane explorer in TRE-16.
 */
export default function HomePage() {
  const { data, isPending, error } = useQuery({
    queryKey: [QUERY_KEYS.HEALTH],
    queryFn: fetchHealth,
    refetchInterval: 5000,
    throwOnError: false,
  });

  return (
    <main className="flex h-screen flex-col items-center justify-center gap-6 font-mono">
      <p className="text-ink text-sm tracking-[0.2em]">TREKKER</p>

      {isPending && <p className="text-ink-dim text-xs">checking api…</p>}

      {error && <p className="text-xs text-amber-400">api unreachable — {error.message}</p>}

      {data && (
        <dl className="text-ink-dim grid grid-cols-[auto_auto] gap-x-6 gap-y-1 text-xs">
          <dt>status</dt>
          <dd className={data.status === "ok" ? "text-emerald-400" : "text-amber-400"}>{data.status}</dd>
          <dt>uptime</dt>
          <dd className="text-ink">{data.uptimeSeconds}s</dd>
          <dt>mysql</dt>
          <dd className={data.dependencies.mysql === "up" ? "text-emerald-400" : "text-amber-400"}>
            {data.dependencies.mysql}
          </dd>
          <dt>redis</dt>
          <dd className={data.dependencies.redis === "up" ? "text-emerald-400" : "text-amber-400"}>
            {data.dependencies.redis}
          </dd>
        </dl>
      )}
    </main>
  );
}
