import { AuthCard, AuthLinks } from "@components/auth/auth-card";

/**
 * The legal notice, same rows as a sibling app's about page (TRE-15 §1).
 *
 * A server component: there is nothing here to interact with, so there is no
 * reason to ship it as JavaScript.
 */
const NOTICE = [
  "Website hosted by OVH SAS",
  "Registered office: 2 rue Kellermann — 59100 Roubaix — France",
  "APE code 2620Z",
  "VAT no.: FR 22 424 761 419",
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
