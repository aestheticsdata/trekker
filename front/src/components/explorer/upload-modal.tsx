"use client";

import { HostPath } from "@components/ui/host-path";
import { Overlay } from "@components/ui/overlay";
import { Tooltip } from "@components/ui/tooltip";
import { formatSize } from "@helpers/listing";
import { isDotFile, MAX_PICKED, pickedFromInput } from "@helpers/picked";
import { PRESS, SELECTED } from "@helpers/press";
import { useEffect, useRef, useState } from "react";

import type { Picked, PickedFile } from "@helpers/picked";
import type { HostView } from "@lib/api/hosts";
import type { ConflictPolicy } from "@lib/api/upload";

/**
 * Naming the destination before the file dialogue opens (TRE-125), and letting
 * a whole folder through it (TRE-126).
 *
 * The upload button used to click a hidden `<input type="file">` directly, and
 * the operating system's dialogue is the one surface this app cannot draw on:
 * it covers the window, and everything it says is about the *source*. So the
 * only two facts that matter — which machine, which directory — were on screen
 * up to the moment they stopped being readable, and the pane that supplied them
 * was distinguished from its neighbour by a 2px edge behind a system window.
 *
 * This modal opens *first*, and the picker opens from inside it. That ordering
 * is the whole ticket. A confirmation shown afterwards would describe a choice
 * already made; the question here is "where am I about to put these", and it is
 * only worth asking while the answer can still change.
 *
 * It works at all because the click on `choose files…` is a user gesture, and a
 * gesture is what a file dialogue needs. Nothing here skins the dialogue or
 * tries to replace it.
 *
 * A drop on a pane raises this same modal with its files already collected, so
 * the gesture that used to send immediately, asking nothing, now confirms the
 * same way the button does.
 */

/** Beyond this the list stops drawing rows and says how many it left out. */
const RENDER_LIMIT = 200;

/**
 * The answers to "the destination already holds this name".
 *
 * `keepBoth` first and selected by default, because it is the only one of the
 * three that cannot lose anything: the server lands `report (2).txt` beside the
 * file that was there. It has been the hard-coded policy since TRE-65 and this
 * is the first time anybody has been shown it, let alone offered the other two.
 */
const POLICIES: ReadonlyArray<{ value: ConflictPolicy; label: string }> = [
  { value: "keepBoth", label: "keep both" },
  { value: "overwrite", label: "overwrite" },
  { value: "skip", label: "skip" },
];

export interface UploadTarget {
  /** The directory the files land in — the pane's own, never its selection. */
  directory: string;
  /** For the colour dot. Null while the host list is still loading. */
  host: HostView | null;
  /** What a drop arrived carrying. The toolbar button opens this modal empty. */
  initial: Picked;
}

export function UploadModal({
  target,
  onClose,
  onConfirm,
}: {
  target: UploadTarget;
  onClose: () => void;
  /** Hands the list back to the explorer, which owns the sending. */
  onConfirm: (files: readonly PickedFile[], conflict: ConflictPolicy) => void;
}) {
  return (
    <Overlay
      label={`Upload into ${target.directory}`}
      onClosed={onClose}
      panelClassName="bg-app border-line-strong flex max-h-[80vh] w-full max-w-[32rem] flex-col overflow-hidden rounded-sm border shadow-2xl"
    >
      {(close) => (
        <UploadPanel
          target={target}
          close={close}
          onConfirm={onConfirm}
        />
      )}
    </Overlay>
  );
}

function UploadPanel({
  target,
  close,
  onConfirm,
}: {
  target: UploadTarget;
  close: () => void;
  onConfirm: (files: readonly PickedFile[], conflict: ConflictPolicy) => void;
}) {
  // Through `merge` even on the way in, so every row has a distinct fingerprint
  // and that fingerprint can be its key.
  const [files, setFiles] = useState<readonly PickedFile[]>(() => merge([], target.initial.files));
  const [truncated, setTruncated] = useState(target.initial.truncated);
  const [conflict, setConflict] = useState<ConflictPolicy>("keepBoth");
  const [skipDots, setSkipDots] = useState(true);

  const filePicker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);
  const commit = useRef<HTMLButtonElement>(null);

  /**
   * `webkitdirectory` is set here rather than in the JSX because it is not a
   * React DOM attribute — it would be dropped from the markup, and the picker
   * would quietly open in file mode, which looks exactly like it working.
   */
  useEffect(() => {
    folderPicker.current?.setAttribute("webkitdirectory", "");
  }, []);

  /**
   * The thing to press, focused once on open — the same reasoning as the field
   * in `create-modal`: inside a dialog the keyboard has nowhere else to be, and
   * `autoFocus` is what a11y lint rejects on a page for good reason.
   */
  useEffect(() => {
    commit.current?.focus();
  }, []);

  const dotted = files.filter((picked) => isDotFile(picked.path)).length;
  const sending = skipDots ? files.filter((picked) => !isDotFile(picked.path)) : files;

  const total = sending.reduce((sum, picked) => sum + picked.file.size, 0);
  const shown = sending.slice(0, RENDER_LIMIT);
  const hidden = sending.length - shown.length;

  const choose = (list: FileList | null) => {
    const picked = pickedFromInput(list);
    setFiles(merge(files, picked.files));
    if (picked.truncated) setTruncated(true);
  };

  return (
    <>
      <header className="bg-chrome border-line flex h-topbar flex-none items-center gap-2 border-b px-3">
        <span className="text-ink-label flex-none font-mono text-xs font-semibold tracking-label">upload</span>
        <span
          aria-hidden
          className="text-ink-faint flex-none font-mono text-xs"
        >
          →
        </span>
        <HostPath
          host={target.host}
          path={target.directory}
        />
        <Tooltip content="Close (⎋)">
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="text-ink-dim flex-none font-mono text-2xs"
          >
            esc ✕
          </button>
        </Tooltip>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {sending.length === 0 ? (
          /* The empty state carries the buttons that matter, rather than
             leaving them to be found in a footer beside `cancel`. */
          <div className="flex flex-col items-center gap-2.5 px-3.5 py-9">
            <span className="text-ink-muted font-mono text-cmd">
              {files.length === 0 ? "Nothing chosen yet." : "Everything chosen is a dot-file."}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => filePicker.current?.click()}
                className={`${PRESS} px-3.5 py-1.75 font-mono text-xs/none font-medium`}
              >
                choose files…
              </button>
              <button
                type="button"
                onClick={() => folderPicker.current?.click()}
                className="border-line-strong text-ink-soft border px-3.5 py-1.75 font-mono text-xs/none"
              >
                choose a folder…
              </button>
            </div>
            <span className="text-ink-faint font-mono text-2xs">or drop them onto a pane</span>
          </div>
        ) : (
          <>
            {shown.map((picked) => (
              <div
                key={fingerprint(picked)}
                className="border-raised flex items-baseline gap-2 border-t px-3.5 py-1.5 first:border-t-0"
              >
                {/* The path, not the name: in a folder upload the name alone
                    would render fifty rows called `index.html`. */}
                <span className="text-ink-muted min-w-0 flex-1 truncate font-mono text-cmd">{picked.path}</span>
                <span className="text-ink-dim flex-none font-mono text-2xs/none">
                  {formatSize(picked.file.size, "file")}
                </span>
              </div>
            ))}
            {hidden > 0 && (
              <div className="text-ink-faint border-raised border-t px-3.5 py-1.5 font-mono text-2xs">
                and {hidden} more, not listed
              </div>
            )}
          </>
        )}
      </div>

      {truncated && (
        <div className="bg-warning-wash border-warning text-warning mx-3.5 mt-2.5 border px-2.5 py-1.75 font-mono text-cmd/[1.5]">
          That is more than {MAX_PICKED} files. Only the first {MAX_PICKED} were collected — send the rest in another
          pass.
        </div>
      )}

      <div className="border-line flex flex-none flex-wrap items-center gap-x-2.5 gap-y-1.5 border-t px-3.5 py-2.25">
        <span className="text-ink-faint font-sans text-3xs/none font-medium tracking-[0.12em] uppercase">
          if it exists
        </span>
        <fieldset
          aria-label="What to do when the destination already holds the name"
          className="border-line-strong flex h-5 flex-none overflow-hidden rounded-sm border"
        >
          {POLICIES.map((policy) => {
            const active = conflict === policy.value;
            return (
              <button
                key={policy.value}
                type="button"
                aria-pressed={active}
                onClick={() => setConflict(policy.value)}
                className={`border-line-strong flex items-center border-l px-2.25 font-mono text-2xs first:border-l-0 ${
                  active ? `${SELECTED} font-medium` : "text-ink-muted"
                }`}
              >
                {policy.label}
              </button>
            );
          })}
        </fieldset>

        {/* Only once there is something to skip. A checkbox about `.DS_Store`
            on an empty panel is a question nobody has yet. */}
        {dotted > 0 && (
          <label className="text-ink-muted flex cursor-pointer items-center gap-1.5 font-mono text-2xs">
            <input
              type="checkbox"
              checked={skipDots}
              onChange={(event) => setSkipDots(event.target.checked)}
            />
            skip {dotted} dot-file{dotted === 1 ? "" : "s"}
          </label>
        )}
      </div>

      <footer className="bg-chrome border-line flex h-11 flex-none items-center gap-2 border-t px-3.5">
        <span className="text-ink-muted font-mono text-2xs/none">
          {sending.length === 0
            ? "nothing to send"
            : `${sending.length} file${sending.length === 1 ? "" : "s"}, ${formatSize(total, "file")}`}
        </span>
        <div className="flex-1" />
        {files.length > 0 && (
          <button
            type="button"
            onClick={() => filePicker.current?.click()}
            className="border-line-strong text-ink-soft border px-3.5 py-1.75 font-mono text-xs/none"
          >
            add more…
          </button>
        )}
        <button
          type="button"
          onClick={close}
          className="border-line-strong text-ink-soft border px-3.5 py-1.75 font-mono text-xs/none"
        >
          cancel
        </button>
        <button
          ref={commit}
          type="button"
          disabled={sending.length === 0}
          onClick={() => {
            onConfirm(sending, conflict);
            close();
          }}
          className={`${PRESS} disabled:bg-line disabled:text-ink-faint px-3.5 py-1.75 font-mono text-xs/none font-medium disabled:cursor-not-allowed`}
        >
          upload
        </button>
      </footer>

      {/* Both pickers, opened from inside the modal so the destination above is
          on screen right up to the moment the system dialogue covers it.
          Hidden rather than absent: `.click()` on an input that is not in the
          document opens nothing. */}
      <input
        ref={filePicker}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          choose(event.target.files);
          // Cleared so choosing the same file twice fires `change` twice. An
          // input keeps its value, and the second attempt would be silent.
          event.target.value = "";
        }}
      />
      <input
        ref={folderPicker}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          choose(event.target.files);
          event.target.value = "";
        }}
      />
    </>
  );
}

/**
 * `add more…`, without the same file twice.
 *
 * Two picks of the same dialogue can name the same file, and two rows for it
 * would be two uploads racing for one name — which `keepBoth` would then
 * resolve into `report.txt` and `report (2).txt`, both of them the same bytes.
 * Path, size and mtime together are as close to identity as the browser gives
 * us for a `File`, and they are enough to notice the case that actually
 * happens: somebody picking the same thing twice.
 */
function merge(current: readonly PickedFile[], chosen: readonly PickedFile[]): readonly PickedFile[] {
  const seen = new Set(current.map(fingerprint));
  return [...current, ...chosen.filter((picked) => !seen.has(fingerprint(picked)))];
}

function fingerprint(picked: PickedFile): string {
  return `${picked.path}:${picked.file.size}:${picked.file.lastModified}`;
}
