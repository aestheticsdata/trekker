import "@styles/globals.css";
import Providers from "@app/providers";
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`dark ${plexSans.variable} ${plexMono.variable}`}
      suppressHydrationWarning
    >
      <body className="bg-app text-ink font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
