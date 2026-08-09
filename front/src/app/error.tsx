"use client";

export default function ErrorBoundary({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="flex h-screen flex-col items-center justify-center gap-4 font-mono text-sm">
      <p className="text-ink">Something broke.</p>
      <p className="text-ink-dim">{error.message}</p>
      <button
        type="button"
        onClick={reset}
        className="border-line text-ink-dim hover:text-ink cursor-pointer border px-3 py-1.5 text-xs tracking-widest"
      >
        RETRY
      </button>
    </main>
  );
}
