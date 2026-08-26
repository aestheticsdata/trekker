"use client";

/**
 * Everything below the root layout, which since TRE-89 includes the private
 * tree's session check — so this is the screen a signed-in operator gets when
 * the API is unreachable, and it has to be worth reading.
 *
 * `retry`, not `reset`: `reset` clears the error state and re-renders the same
 * children without asking the server again, which on an outage redraws this
 * page from what it already has. `retry` re-fetches, which is the only thing
 * that can make the button mean anything here.
 *
 * Outside AuthProvider by construction — it renders in place of the group
 * layout that mounts one — so nothing here may read `useAuth`.
 */
export default function ErrorBoundary({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <main className="flex h-screen flex-col items-center justify-center gap-4 font-mono text-sm">
      <p className="text-ink">Something broke.</p>
      {/* A server-side throw is redacted to a digest in production; the
          identifier is what matches it to the line in the API's log. */}
      <p className="text-ink-dim">{error.message}</p>
      {error.digest && <p className="text-ink-faint text-xs">{error.digest}</p>}
      <button
        type="button"
        onClick={() => retry()}
        className="border-line text-ink-dim hover:text-ink border px-3 py-1.5 text-xs tracking-widest"
      >
        RETRY
      </button>
    </main>
  );
}
