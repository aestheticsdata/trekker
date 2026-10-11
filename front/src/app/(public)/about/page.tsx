import { AuthCard, AuthLinks } from "@components/auth/auth-card";
import useTranslations from "@i18n/useTranslations";

/**
 * The legal notice (TRE-15 §1); its rows live in the auth zone.
 *
 * A server component: there is nothing here to interact with, so there is no
 * reason to ship it as JavaScript.
 */
export default function AboutPage() {
  const t = useTranslations("auth");

  return (
    <AuthCard
      title={t.title}
      subtitle={t.about.subtitle}
      footer={
        <AuthLinks
          links={[
            { href: "/login", label: t.links.signIn },
            { href: "/signup", label: t.links.register },
          ]}
        />
      }
    >
      <ul className="flex flex-col gap-2.5">
        {t.about.notice.map((line) => (
          <li
            key={line}
            className="border-line text-ink-muted border-l-2 pl-3 text-sm leading-relaxed"
          >
            {line}
          </li>
        ))}
      </ul>

      {/* The operator's published identity — see the note in the auth zone. */}
      <p className="border-line text-ink-faint mt-2 border-t pt-3 text-center font-mono text-xs">{t.about.operator}</p>
    </AuthCard>
  );
}
