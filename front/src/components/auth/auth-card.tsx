import Link from "next/link";

import type { ReactNode } from "react";

/**
 * The frame all four auth screens share (TRE-15 §1): one header, one card, one
 * status bar. They are the public face of an app that holds SSH keys, so the
 * copy carries as much weight as the layout.
 *
 * **Nothing here grows or shrinks in response to a failure.** A refusal that
 * has no field to attach to — a wrong key, an unreachable API — is written
 * into the status row, which is always on screen, so the card never resizes
 * under the cursor. Per-field reasons sit on their own labels; see AuthField.
 */

/** The mockup's four states — the whole feedback surface, no spinners elsewhere. */
export type AuthStatus = "IDLE" | "WORKING" | "AUTHENTICATED" | "REJECTED";

const STATUS_CLASS: Record<AuthStatus, string> = {
  IDLE: "text-ink-faint",
  WORKING: "text-warning",
  AUTHENTICATED: "text-success",
  REJECTED: "text-danger-soft",
};

export function AuthCard({
  title,
  subtitle,
  status = "IDLE",
  failure,
  notice,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  status?: AuthStatus;
  /** A refusal with no field of its own. Shown in the status row. */
  failure?: string | null;
  /** Standing copy — a warning that is part of the screen, not a reaction to it. */
  notice?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="border-line w-full max-w-[26rem] border">
        <header className="border-line bg-chrome border-b px-5 py-3.5">
          <h1 className="text-ink text-lg font-semibold tracking-caps">{title}</h1>
          <p className="text-ink-faint mt-0.5 text-xs tracking-label">{subtitle}</p>
        </header>

        <div className="bg-app flex flex-col gap-4 px-5 py-5">
          {notice}
          {children}
        </div>

        <footer className="border-line bg-chrome flex items-center justify-between gap-3 border-t px-5 py-2">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className={`shrink-0 font-mono text-xs tracking-label ${STATUS_CLASS[status]}`}>{status}</span>
            {/* Always present, empty when there is nothing wrong. */}
            <span
              role={failure ? "alert" : undefined}
              title={failure ?? undefined}
              className="text-danger-soft min-w-0 truncate text-xs"
            >
              {failure ?? ""}
            </span>
          </span>
          {footer}
        </footer>
      </div>
    </main>
  );
}

/**
 * A standing panel — the "there is no recovery email" warning, the closed-
 * registration explanation. Part of the screen from the first paint, never a
 * reaction to a submit, so it costs nothing in movement.
 */
export function AuthNotice({ tone, children }: { tone: "error" | "warning" | "info"; children: ReactNode }) {
  const toneClass =
    tone === "error"
      ? "border-danger-mid text-danger-soft"
      : tone === "warning"
        ? "border-warning text-warning"
        : "border-line-strong text-ink-muted";

  return <div className={`border-l-2 py-1 pl-3 text-sm leading-relaxed ${toneClass}`}>{children}</div>;
}

export function AuthLinks({ links }: { links: ReadonlyArray<{ href: string; label: string }> }) {
  return (
    <nav className="flex shrink-0 items-center gap-3">
      {links.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className="text-ink-faint hover:text-ink-muted text-xs tracking-label"
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
