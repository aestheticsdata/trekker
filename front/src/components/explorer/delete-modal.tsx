"use client";

import { useAuth } from "@auth/context/AuthContext";
import { FileMark } from "@components/explorer/file-mark";
import { CommandLine } from "@components/ui/command-line";
import { Overlay } from "@components/ui/overlay";
import { useToast } from "@components/ui/toast";
import { extensionOf, formatSize, MARK_ON_PANEL, rowTypeOf } from "@helpers/listing";
import { DANGER_FILL, DANGER_INK } from "@helpers/press";
import { interpolate } from "@i18n/interpolate";
import useTranslations from "@i18n/useTranslations";
import { ApiError } from "@lib/api/client";
import { deletePaths, planDelete } from "@lib/api/delete";
import { QUERY_KEYS } from "@lib/query/keys";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { DeletePlan } from "@lib/api/delete";
import type { FileRow } from "@lib/api/fs";

/**
 * Deleting, with the friction that is the feature (TRE-25 §3).
 *
 * Every other modal in this application is arranged to make its operation easy.
 * This one is arranged to make it *deliberate*: the plan is fetched and shown
 * before anything can be typed, the button stays inert until the words match,
 * and the words are the file's own name — so confirming is a sentence about
 * that file rather than a reflex aimed at whatever had focus.
 *
 * Nothing here decides anything. The count, the size, the risk line and the
 * token all come from the server's walk, and the server derives the token again
 * when the delete arrives. What this file does is refuse to let the button work
 * until the reader has demonstrated they read it.
 */

export interface DeleteTargetSelection {
  hostId: string;
  directory: string;
  /** What is selected, in listing order. Never empty. */
  entries: readonly FileRow[];
  /**
   * Which surface opened this, when it was not a button (TRE-35).
   *
   * The plan is not marked and does not need to be — it reads and is exempt
   * from the log. What is marked is the delete itself, which is the row anyone
   * would ever go looking for.
   */
  origin?: "terminal";
}

export function DeleteModal({
  target,
  onClose,
  onApplied,
}: {
  target: DeleteTargetSelection;
  onClose: () => void;
  onApplied: () => void;
}) {
  const t = useTranslations("dialogs");
  const subject =
    target.entries.length === 1
      ? target.entries[0].name
      : interpolate(t.common.entriesIn, { count: target.entries.length, directory: target.directory });

  return (
    <Overlay
      label={interpolate(t.delete.dialog, { subject })}
      onClosed={onClose}
      testId="delete-modal"
      panelClassName="bg-app border-danger-mid flex w-full max-w-[46.25rem] flex-col overflow-hidden rounded-sm border shadow-2xl"
    >
      {(close) => (
        <DeletePanel
          target={target}
          subject={subject}
          close={close}
          onApplied={onApplied}
        />
      )}
    </Overlay>
  );
}

function DeletePanel({
  target,
  subject,
  close,
  onApplied,
}: {
  target: DeleteTargetSelection;
  subject: string;
  close: () => void;
  onApplied: () => void;
}) {
  const t = useTranslations("dialogs");
  const { csrfToken } = useAuth();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const { hostId, directory, entries, origin } = target;

  const paths = entries.map((entry) => joinPath(directory, entry.name));

  const [typed, setTyped] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  /**
   * Asked once, when the modal opens. Not refetched on focus: the number the
   * reader is about to confirm must not change under the cursor while they are
   * typing it. The delete walks again on the server anyway, so a tree that
   * changed in between is caught where it matters.
   */
  const plan = useQuery({
    queryKey: [QUERY_KEYS.DELETE_PLAN, hostId, ...paths],
    queryFn: () => planDelete(hostId, paths, csrfToken),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    throwOnError: false,
    retry: false,
  });

  const remove = useMutation({
    mutationFn: () => deletePaths(hostId, paths, typed, csrfToken, origin),
    throwOnError: false,
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.DIRECTORY, hostId] });
      void queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.ENTRY, hostId] });

      if (result.failed > 0) {
        const survived = result.results.filter((outcome) => !outcome.ok);
        push({
          tone: "warning",
          message: interpolate(t.delete.partial, {
            removed: result.entriesRemoved,
            total: result.entriesRemoved + survived.length,
          }),
          detail: survived[0]?.message ?? t.delete.someFailed,
        });
      } else {
        push({
          tone: "success",
          message: interpolate(t.delete.deleted, {
            entries: count(result.entriesRemoved, t.common.entryOne, t.common.entryMany),
          }),
          detail: interpolate(t.delete.freed, { size: formatSize(result.bytesFreed, "file") }),
        });
      }

      onApplied();
      close();
    },
    onError: (error) => {
      setFailure(error instanceof ApiError ? error.message : t.delete.failure);
    },
  });

  const ready = plan.data !== undefined && !plan.data.needsElevation;
  const armed = ready && typed.trim() === plan.data.token.trim();
  const refusal = plan.error instanceof ApiError ? plan.error.message : null;

  return (
    <>
      <header className="bg-danger-wash border-danger-mid flex h-topbar flex-none items-center gap-2 border-b px-3">
        <span className="text-danger-soft font-mono text-xs font-semibold tracking-label">{t.delete.title}</span>
        <span className="text-ink-muted min-w-0 truncate font-mono text-cmd">{subject}</span>
      </header>

      {refusal !== null && (
        <div className="bg-danger-wash border-danger text-danger-soft mx-3.5 mt-2.5 border px-2.5 py-1.75 font-mono text-cmd/[1.5]">
          {refusal}
        </div>
      )}

      {plan.data?.needsElevation === true && (
        <div className="bg-danger-wash border-warning text-warning mx-3.5 mt-2.5 border px-2.5 py-1.75 font-mono text-cmd/[1.5]">
          {interpolate(t.delete.elevation, {
            entries: plan.data.entries.toLocaleString("en-GB"),
            threshold: plan.data.threshold.toLocaleString("en-GB"),
          })}
        </div>
      )}

      <div className="border-line max-h-70 flex-1 overflow-y-auto border-t border-b">
        {plan.isPending && <div className="text-ink-faint px-3.5 py-3 font-mono text-xs">{t.delete.walking}</div>}
        {plan.data?.targets.map((row) => (
          <div
            key={row.path}
            data-testid="delete-target"
            data-name={row.name}
            className="border-raised grid grid-cols-[auto_1fr_auto_auto] items-center gap-2.5 border-t px-3.5 py-1.5"
          >
            <FileMark
              type={rowTypeOf(row.kind)}
              extension={extensionOf(row.name)}
              ink={MARK_ON_PANEL}
            />
            <span className="text-ink-muted truncate font-mono text-xs/[1.3]">{row.name}</span>
            <span className="text-ink-dim font-mono text-2xs/none">
              {row.kind === "directory"
                ? interpolate(t.delete.recursive, {
                    entries: count(row.entries, t.common.entryOne, t.common.entryMany),
                  })
                : row.kind}
            </span>
            <span className="text-ink-soft w-20 text-right font-mono text-xs/[1.3]">
              {formatSize(row.bytes, "file")}
            </span>
          </div>
        ))}
      </div>

      {plan.data !== undefined && (
        <div className="flex flex-col gap-2 px-3.5 py-2.5">
          <RiskLine plan={plan.data} />

          {/* Drawn by the shared component since TRE-29, so that the prompt
              character here and the one in the permissions modal agree about
              whether this session is elevated. */}
          <CommandLine
            hostId={hostId}
            command={plan.data.command}
            className="overflow-x-auto whitespace-pre"
          />

          <label className="flex flex-col gap-1">
            <span className="text-ink-faint font-mono text-2xs tracking-label">
              {interpolate(t.delete.tokenPrompt, { token: plan.data.token })}
            </span>
            <input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              disabled={plan.data.needsElevation}
              // Deliberately not autofocused, and not only because the linter
              // says so. Every other modal here can afford to put the cursor
              // where the work is; this one is asking the reader to stop, and a
              // field that is already focused is one a reflex can type into.
              spellCheck={false}
              autoComplete="off"
              aria-label={interpolate(t.delete.tokenLabel, { token: plan.data.token })}
              // The accessible name carries the server's token, so it is
              // different for every plan — this is the stable handle.
              data-testid="delete-token"
              className={`bg-chrome text-ink w-full border px-2.25 py-1.75 font-mono text-name/none disabled:opacity-50 ${
                armed ? "border-success text-success" : "border-danger-mid"
              }`}
            />
          </label>
        </div>
      )}

      {failure !== null && (
        <div className="bg-danger-wash border-danger text-danger-soft mx-3.5 mb-2.5 border px-2.5 py-1.75 font-mono text-cmd/[1.5]">
          {failure}
        </div>
      )}

      <footer className="bg-chrome flex h-11 flex-none items-center gap-2 px-3.5">
        <span className="text-ink-muted font-mono text-2xs/none">
          {plan.data === undefined
            ? ""
            : interpolate(t.delete.summary, {
                entries: count(plan.data.entries, t.common.entryOne, t.common.entryMany),
                size: formatSize(plan.data.bytes, "file"),
              })}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={close}
          data-testid="delete-cancel"
          className="border-line-strong text-ink-soft border px-3.5 py-1.75 font-mono text-xs/none"
        >
          {t.common.cancel}
        </button>
        <button
          type="button"
          onClick={() => remove.mutate()}
          disabled={!armed || remove.isPending}
          // ⚠️ The one control in this dialog that removes anything, and it
          // sits one gap from `cancel`. Its own name, so nothing fuzzier than
          // this can ever reach it.
          data-testid="delete-confirm"
          // Dark red, and red even while inert: this button should never look
          // like the one beside it.
          className={`${DANGER_FILL} ${DANGER_INK} disabled:bg-line disabled:text-ink-faint px-3.5 py-1.75 font-mono text-xs/none font-medium disabled:cursor-not-allowed`}
        >
          {remove.isPending ? t.delete.deleting : t.delete.confirm}
        </button>
      </footer>
    </>
  );
}

/**
 * What is about to go that the reader might not have noticed.
 *
 * Only what is true — an empty risk line is better than one that lists zeroes,
 * because a line that always says something is a line nobody reads.
 */
function RiskLine({ plan }: { plan: DeletePlan }) {
  const t = useTranslations("dialogs");
  const { common } = t;
  const notes: string[] = [];
  if (plan.risk.directories > 0) notes.push(count(plan.risk.directories, common.directoryOne, common.directoryMany));
  if (plan.risk.rootOwned > 0) {
    notes.push(
      interpolate(t.delete.risk.rootOwned, {
        entries: count(plan.risk.rootOwned, common.entryOne, common.entryMany),
      }),
    );
  }
  if (plan.risk.links > 0) {
    notes.push(
      interpolate(t.delete.risk.links, { links: count(plan.risk.links, common.symlinkOne, common.symlinkMany) }),
    );
  }
  if (plan.risk.unreadable > 0) {
    notes.push(
      interpolate(t.delete.risk.unreadable, {
        directories: count(plan.risk.unreadable, common.directoryOne, common.directoryMany),
      }),
    );
  }

  if (notes.length === 0) return null;

  return (
    <span className="text-warning font-mono text-2xs/[1.6]">
      {interpolate(t.delete.risk.contains, { notes: notes.join(" · ") })}
    </span>
  );
}

function joinPath(directory: string, name: string): string {
  return directory.endsWith("/") ? `${directory}${name}` : `${directory}/${name}`;
}

/** A count in words, from the zone's `{count}` pair. */
function count(n: number, one: string, many: string): string {
  return interpolate(n === 1 ? one : many, { count: n });
}
