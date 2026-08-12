import { AuthCard, AuthLinks } from "@components/auth/auth-card";

/**
 * The legal notice, same rows as a sibling app's about page (TRE-15 §1).
 *
 * A server component: there is nothing here to interact with, so there is no
 * reason to ship it as JavaScript.
 */
const NOTICE = [
  "Trekker — a file explorer for the servers you actually run.",
  "Published as free software; the source is public on GitHub.",
  "No analytics, no third-party requests, no data leaves the host it runs on.",
  "Provided as is, without warranty of any kind.",
] as const;

export default function AboutPage() {
  return (
    <AuthCard
      title="TREKKER"
      subtitle="About"
      footer={
        <AuthLinks
          links={[
            { href: "/login", label: "sign in" },
            { href: "/signup", label: "register" },
          ]}
        />
      }
    >
      <ul className="flex flex-col gap-2.5">
        {NOTICE.map((line) => (
          <li
            key={line}
            className="border-line text-ink-muted border-l-2 pl-3 text-sm leading-relaxed"
          >
            {line}
          </li>
        ))}
      </ul>

      {/* The domain is deliberate and stays: it is the operator's published
          identity, which is a legal requirement, not an infrastructure leak.
          Recorded here so TRE-5's sweeps stop re-raising it. */}
      <p className="border-line text-ink-faint mt-2 border-t pt-3 text-center font-mono text-xs">
        trekker · 1991computer.com
      </p>
    </AuthCard>
  );
}
