"use client";

import { Button, Segmented, TextInput } from "@components/hosts/field";
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
  const replace = (index: number, patch: Partial<HostRoot>) => {
    onChange(roots.map((root, position) => (position === index ? { ...root, ...patch } : root)));
  };

  const pinned = enforced && roots.length === 1;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-ink-muted font-mono text-2xs tracking-label">roots</span>
        <span className="text-danger-soft truncate text-right font-mono text-2xs">{error ?? ""}</span>
      </div>

      {/* Said before the rules visibly differ, not after a save quietly works.
          An input that stops refusing what it used to refuse, with nothing to
          explain it, reads as a bug rather than as a privilege. */}
      {!enforced && (
        <p className="text-ink-muted font-mono text-2xs/relaxed">
          You own this install, so these rows are saved without being enforced — your panes resolve against{" "}
          <code>/</code>. They bind again the moment this host belongs to an account that is not the owner.
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
              className="border-line flex items-center gap-1.5 border-b p-1 last:border-b-0"
            >
              <TextInput
                value={root.path}
                onChange={(event) => replace(index, { path: event.target.value })}
                placeholder="/srv"
                aria-label={`Root ${index + 1} path`}
                spellCheck={false}
                autoComplete="off"
                className="flex-1 border-0 bg-transparent"
              />

              {/* Says why this row cannot be removed before the button is reached for. */}
              <span
                className={`w-8 flex-none text-center font-mono text-3xs tracking-label ${
                  holdsHome ? "text-accent-soft" : "text-transparent"
                }`}
                title={holdsHome ? "The home sits inside this root" : undefined}
              >
                HOME
              </span>

              <Segmented
                label={`Root ${index + 1} access`}
                value={root.access}
                onChange={(access) => replace(index, { access })}
                options={[
                  { value: "READ", label: "read" },
                  { value: "WRITE", label: "write", title: "Write implies read" },
                ]}
              />

              <button
                type="button"
                onClick={() => onChange(roots.filter((_, position) => position !== index))}
                disabled={pinned}
                aria-label={`Remove root ${index + 1}`}
                title={pinned ? "A host needs at least one root" : "Remove this root"}
                className={`px-1 font-mono text-xs ${
                  pinned ? "text-line-strong cursor-not-allowed" : "text-ink-faint hover:text-danger-soft"
                }`}
              >
                ✕
              </button>
            </div>
          );
        })}

        {/* Only an owner can get here, and the box would otherwise collapse to a
            border around nothing, which reads as a failed render. */}
        {roots.length === 0 && (
          <p className="text-ink-faint p-2 font-mono text-2xs">
            No roots. Nothing about this host is written down as a boundary.
          </p>
        )}
      </div>

      <div>
        <Button
          type="button"
          onClick={() => onChange([...roots, { path: "", access: "READ" }])}
        >
          + add root
        </Button>
      </div>
    </div>
  );
}
