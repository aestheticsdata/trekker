"use client";

import { Button, Segmented, TextInput } from "@components/hosts/field";
import { Tooltip } from "@components/ui/tooltip";
import { interpolate } from "@i18n/interpolate";
import useTranslations from "@i18n/useTranslations";
import { contains } from "@schemas/host";

import type { HostRoot } from "@lib/api/hosts";

/**
 * The allowlist editor (TRE-43 §2).
 *
 * Roots are the security boundary (TRE-11), so they get rows and a visible
 * access level rather than a comma-separated text field: `/var:WRITE,/srv` is
 * a format nobody should have to know, and a typo in it silently widens what
 * the app can reach.
 *
 * WRITE implies READ. There is no third level and no ordering — the guard
 * stops at the first root that admits a path — so a row says everything about
 * itself.
 */
export function RootsEditor({
  roots,
  homePath,
  enforced,
  error,
  onChange,
}: {
  roots: readonly HostRoot[];
  /** Marked in place, because a home outside every root is the mistake to catch. */
  homePath: string;
  /**
   * Whether these rows bind the account editing them (TRE-49). False for the
   * install's owner, who resolves against `/` whatever is listed here — the
   * editor stays, because the rows are still stored and still describe what
   * this host would be bounded by.
   */
  enforced: boolean;
  error?: string;
  onChange: (roots: HostRoot[]) => void;
}) {
  const t = useTranslations("hosts");
  const replace = (index: number, patch: Partial<HostRoot>) => {
    onChange(roots.map((root, position) => (position === index ? { ...root, ...patch } : root)));
  };

  const pinned = enforced && roots.length === 1;

  return (
    <div
      data-testid="host-roots"
      className="flex flex-col gap-1"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-ink-muted font-mono text-2xs tracking-label">{t.roots.heading}</span>
        <span className="text-danger-soft truncate text-right font-mono text-2xs">{error ?? ""}</span>
      </div>

      {/* Said before the rules visibly differ, not after a save quietly works.
          An input that stops refusing what it used to refuse, with nothing to
          explain it, reads as a bug rather than as a privilege. */}
      {!enforced && (
        <p className="text-ink-muted font-mono text-2xs/relaxed">
          {t.roots.unenforced.before} <code>/</code>
          {t.roots.unenforced.after}
        </p>
      )}

      <div className="border-line-strong flex flex-col rounded-xs border">
        {roots.map((root, index) => {
          const holdsHome = contains(root.path, homePath);
          return (
            <div
              // Rows are positional: two may be blank at once while being typed,
              // so the path cannot be the identity.
              // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
              key={index}
              // The same identity as the key, for the same reason.
              data-testid="host-root"
              data-index={index}
              className="border-line flex items-center gap-1.5 border-b p-1 last:border-b-0"
            >
              <TextInput
                value={root.path}
                onChange={(event) => replace(index, { path: event.target.value })}
                placeholder={t.roots.pathPlaceholder}
                aria-label={interpolate(t.roots.pathLabel, { index: index + 1 })}
                spellCheck={false}
                autoComplete="off"
                data-testid="host-root-path"
                className="flex-1 border-0 bg-transparent"
              />

              {/* Says why this row cannot be removed before the button is reached for. */}
              <Tooltip content={holdsHome ? t.roots.holdsHome : undefined}>
                <span
                  className={`w-8 flex-none text-center font-mono text-3xs tracking-label ${
                    holdsHome ? "text-ink-label" : "text-transparent"
                  }`}
                >
                  {t.roots.home}
                </span>
              </Tooltip>

              <Segmented
                label={interpolate(t.roots.accessLabel, { index: index + 1 })}
                value={root.access}
                onChange={(access) => replace(index, { access })}
                options={[
                  { value: "READ", label: t.roots.read },
                  { value: "WRITE", label: t.roots.write, hint: t.roots.writeHint },
                ]}
              />

              <Tooltip content={pinned ? t.roots.lastRoot : t.roots.remove}>
                <button
                  type="button"
                  // `aria-disabled`, not `disabled` (TRE-76): the pinned case is
                  // the one with something to explain, and it was the one nobody
                  // could hover or reach.
                  aria-disabled={pinned}
                  onClick={() => !pinned && onChange(roots.filter((_, position) => position !== index))}
                  aria-label={interpolate(t.roots.removeLabel, { index: index + 1 })}
                  data-testid="host-root-remove"
                  className={`px-1 font-mono text-xs ${
                    pinned ? "text-line-strong cursor-not-allowed" : "text-ink-faint hover:text-danger-soft"
                  }`}
                >
                  ✕
                </button>
              </Tooltip>
            </div>
          );
        })}

        {/* Only an owner can get here, and the box would otherwise collapse to a
            border around nothing, which reads as a failed render. */}
        {roots.length === 0 && <p className="text-ink-faint p-2 font-mono text-2xs">{t.roots.empty}</p>}
      </div>

      <div>
        <Button
          type="button"
          onClick={() => onChange([...roots, { path: "", access: "READ" }])}
          data-testid="host-root-add"
        >
          {t.roots.add}
        </Button>
      </div>
    </div>
  );
}
