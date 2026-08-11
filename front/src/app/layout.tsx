import "@styles/globals.css";
import Providers from "@app/providers";
import { getServerSession } from "@auth/server/getServerSession";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";

import type { Metadata } from "next";

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
