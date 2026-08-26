"use client";

import "@styles/globals.css";
import { IBM_Plex_Mono } from "next/font/google";

/**
 * The last fallback (TRE-89).
 *
 * `app/error.tsx` is a boundary Next places *inside* the root layout, around
 * its children, so it covers every segment below — the `(private)` layout's
 * session check included — and structurally cannot cover the root layout
 * itself. This file is the only thing that can, which is why it renders its own
 * `<html>` and `<body>`: it replaces the root layout rather than sitting under
 * it, and none of that layout's styles, fonts or classes reach here.
 *
 * Nothing routine reaches it and nothing routine should. It exists so a throw
 * in the shell is a page with a button on it rather than a blank document. It
 * renders in development too, behind the dev overlay — dismiss the overlay to
 * see it — and the production build is where it is worth confirming, because a
 * server-side throw arrives there redacted to a digest.
 *
 * The typeface is declared again because `--font-plex-mono` is set by the root
 * layout's class, which is not rendering.
 */
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400"],
  variable: "--font-plex-mono",
  display: "swap",
});

export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html
      lang="en"
      className={plexMono.variable}
    >
      <body className="bg-app text-ink font-mono antialiased">
        <main className="flex h-screen flex-col items-center justify-center gap-4 text-sm">
          <p className="text-ink">Trekker could not start.</p>
          {/* Redacted to a digest in a production build, deliberately, so the
              sentence is not always worth showing — the identifier always is:
              it is what matches this crash to a line in the API log. */}
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
      </body>
    </html>
  );
}
