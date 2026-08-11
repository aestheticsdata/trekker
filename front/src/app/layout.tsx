import "@styles/globals.css";
import Providers from "@app/providers";
import { getServerSession } from "@auth/server/getServerSession";
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

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Resolved on the server so the app renders already knowing who is signed in.
  // Anonymous visitors cost nothing here: with no cookie this returns without
  // a round trip. Memoised per request, so the private layout's own check
  // below does not ask twice.
  const session = await getServerSession();

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

        <Providers
          initialUser={session?.user ?? null}
          initialCsrfToken={session?.csrfToken ?? null}
        >
          {children}
        </Providers>
      </body>
    </html>
  );
}
