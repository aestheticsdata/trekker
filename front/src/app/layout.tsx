import "@styles/globals.css";
import Providers from "@app/providers";
import { UI_BASE_SCRIPT } from "@helpers/ui-scale";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";

import type { Metadata, Viewport } from "next";

// next/font downloads these at build time and serves them from our own origin —
// no runtime request to Google. That is what TRE-14 means by "self-hosted".
const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-plex-sans",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Trekker",
  description: "A file explorer for the servers you actually run.",
  icons: {
    icon: [
      { url: "/favicon/trekker.svg", type: "image/svg+xml" },
      { url: "/favicon/trekker-32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: [{ url: "/favicon/trekker-180.png" }],
  },
  manifest: "/favicon/site.webmanifest",
};

export const viewport: Viewport = {
  themeColor: "#0c2a44",
};

/**
 * The document, and nothing in it that can fail (TRE-89).
 *
 * The session used to be resolved here and handed down through `Providers`,
 * which put the whole app — the login screen included — behind one API round
 * trip. When the API was unreachable `getServerSession` threw in this layout,
 * and a throw in a layout is not caught by the `error.tsx` beside it: that
 * boundary is placed *inside* this file, around `children`, so it covers
 * everything below and nothing here. There was nothing above it either, so an
 * outage took out the one screen an operator reaches for during an outage.
 *
 * The seed sits in the two group layouts now, where the sibling apps keep it.
 * `(private)` already had to ask in order to guard, so it hands down the answer
 * it guarded on; `(public)` asks nothing at all, which is what makes the login
 * screen reachable while the API is down — by structure rather than by a catch.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`dark ${plexSans.variable} ${plexMono.variable}`}
      suppressHydrationWarning
    >
      <body className="bg-app text-ink font-sans antialiased">
        {/* Applies the stored interface size before the first paint, so the app
            never renders at one size and jumps to another (TRE-44 §5). */}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a literal string built in our own module from two integer constants, with no input from anywhere */}
        <script dangerouslySetInnerHTML={{ __html: UI_BASE_SCRIPT }} />

        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
