"use client";

import { useAuth } from "@auth/context/AuthContext";
import { Overlay } from "@components/ui/overlay";
import { useToast } from "@components/ui/toast";
import { ApiError } from "@lib/api/client";
import { createDirectory, createFile } from "@lib/api/create";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import type { FileRowDetail } from "@lib/api/fs";

/**
 * Making a new directory or a new empty file (TRE-69 §3).
 *
 * One component for both, the way `transfer-modal` serves copy and move and
 * `rename-modal` serves name and pattern: the two differ in one word and one
 * route, and two files would be one file and a copy of it.
 *
 * The collision is named twice on purpose. This side checks the name against
 * the listing the pane already has, so typing over an existing entry says so
 * while the field still has focus and before anything is sent — and the server
 * checks again, from the filesystem, which is the only check that is actually
 * true. The first is fast and the second is right; neither replaces the other.
 *
 * Nothing here creates a path. The route takes a directory and a name, and this
 * form never joins them.
 */

/** Which entry the modal is about to make. */
export type CreateMode = "dir" | "file";

export interface CreateTarget {
  hostId: string;
  /** The directory the new entry goes in — the pane's own. */
  directory: string;
  /** Every name already showing in that directory, for the check before the send. */
  existing: readonly string[];
}

export function CreateModal({
  target,
  initialMode,
  onClose,
  onCreated,
}: {
  target: CreateTarget;
  initialMode: CreateMode;
  onClose: () => void;
  /** The entry as the server statted it, so the caller can go and select it. */
  onCreated: (entry: FileRowDetail) => void;
}) {
  return (
    <Overlay
      label={`New entry in ${target.directory}`}
      onClosed={onClose}
      panelClassName="bg-app border-line-strong flex w-full max-w-[28rem] flex-col overflow-hidden rounded-sm border shadow-2xl"
    >
      {(close) => (
        <CreatePanel
          target={target}
          initialMode={initialMode}
          close={close}
          onCreated={onCreated}
        />
      )}
    </Overlay>
  );
}

function CreatePanel({
  target,
  initialMode,
  close,
  onCreated,
}: {
  target: CreateTarget;
  initialMode: CreateMode;
  close: () => void;
  onCreated: (entry: FileRowDetail) => void;
}) {
  const { csrfToken } = useAuth();
  const { push } = useToast();
  const { hostId, directory, existing } = target;

  const [mode, setMode] = useState<CreateMode>(initialMode);
  const [name, setName] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  const typed = name.trim() === "" ? null : name;
  // Against the listing the pane is already showing. It cannot be authoritative
  // — the directory may have changed since it was fetched — and it does not
  // have to be: the server refuses with a 409 either way, and this only saves
  // the round trip for the case the operator can already see.
  const collides = typed !== null && existing.includes(name);
  const problem = typed === null ? null : (nameProblem(name) ?? (collides ? "Already in this directory." : null));

  const create = useMutation({
    mutationFn: () => {
      setFailure(null);
      const input = { hostId, path: directory, name };
      return mode === "dir" ? createDirectory(input, csrfToken) : createFile(input, csrfToken);
    },
    throwOnError: false,
    onSuccess: (entry) => {
      onCreated(entry);
      push({ tone: "success", message: `${entry.name} created`, detail: directory });
      close();
    },
    onError: (error) => {
      setFailure(error instanceof ApiError ? error.message : "The entry could not be created.");
    },
  });

  const ready = typed !== null && problem === null && !create.isPending;

  /**
   * The field this modal exists for, focused once on open. An effect rather
   * than `autoFocus`, which a11y lint rejects on a page for good reason —
   * inside a dialog the keyboard has nowhere else to be.
   */
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    field.current?.focus();
  }, []);

  return (
    <>
      <header className="bg-line border-line-strong flex h-topbar flex-none items-center gap-2.25 border-b px-3">
        <span className="text-ink font-mono text-xs font-semibold tracking-label">new</span>
        <div className="flex-1" />
        {/* Both, always visible: whichever one the caller opened, the other is
            one click away rather than behind a second entry point. */}
        <fieldset
          aria-label="What to create"
          className="border-line-strong flex h-5 flex-none overflow-hidden rounded-sm border"
        >
          {(["dir", "file"] as const).map((option) => {
            const active = mode === option;
            return (
              <button
                key={option}
                type="button"
                aria-pressed={active}
                onClick={() => setMode(option)}
                className={`border-line-strong flex items-center border-l px-2.25 font-mono text-2xs first:border-l-0 ${
                  active ? "bg-accent-soft text-on-accent font-medium" : "text-ink-muted"
                }`}
              >
                {option}
              </button>
            );
          })}
        </fieldset>
        <button
          type="button"
          onClick={close}
          aria-label="Close"
          title="Close (⎋)"
          className="text-ink-dim font-mono text-2xs"
        >
          esc ✕
        </button>
      </header>

      <div className="px-3.5 pt-3.25 pb-2.5">
        {/* Where this lands, above the field, so the directory is never a thing
            the operator has to remember from the pane behind the dialog. */}
        <div className="text-ink-faint mb-1.25 flex items-baseline gap-2 font-sans text-3xs/none font-medium tracking-[0.12em] uppercase">
          <span>in</span>
          <span
            title={directory}
            className="text-ink-dim min-w-0 truncate font-mono text-2xs/none tracking-normal normal-case"
          >
            {directory}
          </span>
        </div>

        <div className="mb-1.25 flex items-baseline justify-between gap-2">
          <span className="text-ink-faint font-sans text-3xs/none font-medium tracking-[0.12em] uppercase">name</span>
          {/* Always rendered, so nothing on the form moves when a problem
              appears — the rule the auth screens set. */}
          <span
            role="alert"
            className="text-danger-soft min-w-0 truncate font-mono text-2xs/none"
          >
            {problem ?? " "}
          </span>
        </div>

        <input
          ref={field}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && ready) create.mutate();
          }}
          placeholder={mode === "dir" ? "reports" : "notes.md"}
          aria-label={mode === "dir" ? "New directory name" : "New file name"}
          className={`bg-chrome text-ink w-full border px-2.25 py-1.75 font-mono text-name/none ${
            problem ? "border-danger" : "border-accent"
          }`}
        />
      </div>

      {failure && (
        <div className="bg-danger-wash border-danger text-danger-soft mx-3.5 mb-2.5 border px-2.5 py-1.75 font-mono text-cmd/[1.5]">
          {failure}
        </div>
      )}

      <footer className="bg-chrome border-line flex h-11 flex-none items-center gap-2 border-t px-3.5">
        <span className="text-ink-muted font-mono text-2xs/none">
          {mode === "dir" ? "an empty directory" : "an empty file, 0 bytes"}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={close}
          className="border-line-strong text-ink-soft border px-3.5 py-1.75 font-mono text-xs/none"
        >
          cancel
        </button>
        <button
          type="button"
          onClick={() => create.mutate()}
          disabled={!ready}
          className="bg-accent text-on-accent disabled:bg-line disabled:text-ink-faint px-3.5 py-1.75 font-mono text-xs/none font-medium disabled:cursor-not-allowed"
        >
          {create.isPending ? "creating…" : mode === "dir" ? "mkdir" : "create"}
        </button>
      </footer>
    </>
  );
}

/**
 * The name rules, restated for the field rather than imported.
 *
 * The server's `entry-name.ts` is the authority and refuses every one of these
 * again — this exists so the button goes inert as the character is typed
 * instead of after a round trip. The messages are the server's, deliberately:
 * the same problem read the same way whichever side noticed it.
 *
 * The byte ceiling is not checked here. Counting UTF-8 bytes in the browser to
 * pre-empt a refusal nobody meets by accident is the kind of duplication that
 * eventually disagrees with the filesystem it is guessing about.
 */
function nameProblem(name: string): string | null {
  if (name.includes("/")) return "A name is one segment — it cannot contain “/”.";
  if (name === "." || name === "..") return `“${name}” names a directory, not a file.`;
  if (name !== name.trim()) return "A name cannot start or end with a space.";
  if (name.endsWith(".")) return "A name cannot end with a dot.";
  return null;
}
