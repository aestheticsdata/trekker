"use client";

import { useAuth } from "@auth/context/AuthContext";
import { Overlay } from "@components/ui/overlay";
import { Tooltip } from "@components/ui/tooltip";
import { formatSize } from "@helpers/listing";
import { PRESS, SELECTED } from "@helpers/press";
import { ApiError } from "@lib/api/client";
import { planTransfer, startTransfer } from "@lib/api/transfers";
import { QUERY_KEYS } from "@lib/query/keys";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { HostView } from "@lib/api/hosts";
import type { ConflictStrategy, PlannedItem, TransferOperation, TransferPlan } from "@lib/api/transfers";

/**
 * Deciding a transfer (TRE-24 §1, §2).
 *
 * The densest screen in the application, and it earns it: two machines, two
 * paths, and one row per entry with both sides' size and date. Everything on it
 * comes from `POST /transfers/plan` — not from what the panes happen to have
 * cached, because the destination may have changed since it was last listed and
 * a conflict the modal did not know about is the one that surprises somebody.
 *
 * What this file decides is nothing. It shows the server's walk, collects a
 * blanket answer and any per-row overrides, and posts them back. The numbers,
 * the conflict lines, the free space and the refusals are all the server's, so
 * the thing that decides whether a transfer may happen is also the thing that
 * performs it.
 */

/** Beyond this the list stops rendering rows and says how many it left out. */
const RENDER_LIMIT = 200;

const STRATEGIES: ReadonlyArray<{ value: ConflictStrategy; label: string }> = [
  { value: "ask", label: "ask" },
  { value: "overwrite", label: "overwrite all" },
  { value: "skip", label: "skip all" },
  { value: "keepBoth", label: "keep both" },
];

export interface TransferTarget {
  operation: TransferOperation;
  srcHostId: string;
  srcPaths: readonly string[];
  dstHostId: string;
  dstPath: string;
}

export function TransferModal({
  target,
  hosts,
  onClose,
  onStarted,
}: {
  target: TransferTarget;
  hosts: readonly HostView[];
  onClose: () => void;
  onStarted: () => void;
}) {
  // "transfer" when the hosts differ, because that is what it is: the bytes
  // leave one machine and arrive at another, and calling that a copy invites
  // the assumption that it is as instant as one within a disk.
  const verb = target.srcHostId === target.dstHostId ? target.operation : "transfer";

  return (
    <Overlay
      label={`${verb} to ${target.dstPath}`}
      onClosed={onClose}
      panelClassName="bg-app border-line-strong flex w-full max-w-[56rem] flex-col overflow-hidden rounded-sm border shadow-2xl"
    >
      {(close) => (
        <TransferPanel
          target={target}
          verb={verb}
          hosts={hosts}
          close={close}
          onStarted={onStarted}
        />
      )}
    </Overlay>
  );
}

function TransferPanel({
  target,
  verb,
  hosts,
  close,
  onStarted,
}: {
  target: TransferTarget;
  verb: string;
  hosts: readonly HostView[];
  close: () => void;
  onStarted: () => void;
}) {
  const { csrfToken } = useAuth();
  const queryClient = useQueryClient();

  const [strategy, setStrategy] = useState<ConflictStrategy>("ask");
  const [overrides, setOverrides] = useState<Record<string, ConflictStrategy>>({});
  const [failure, setFailure] = useState<string | null>(null);

  /**
   * Asked when the modal opens, and asked again on nothing.
   *
   * Not refetched on window focus: the operator is reading a list and deciding
   * on it, and a plan that changed under the cursor mid-decision would be a
   * different list with their answers scattered across it. The transfer walks
   * again server-side anyway, so a tree that moves in between is caught where
   * it can be acted on.
   */
  const plan = useQuery({
    queryKey: [
      QUERY_KEYS.TRANSFER_PLAN,
      target.operation,
      target.srcHostId,
      target.dstHostId,
      target.dstPath,
      ...target.srcPaths,
    ],
    queryFn: () =>
      planTransfer(
        {
          srcHostId: target.srcHostId,
          srcPaths: target.srcPaths,
          dstHostId: target.dstHostId,
          dstPath: target.dstPath,
          operation: target.operation,
        },
        csrfToken,
      ),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    throwOnError: false,
    retry: false,
  });

  const start = useMutation({
    mutationFn: () =>
      startTransfer(
        {
          srcHostId: target.srcHostId,
          srcPaths: target.srcPaths,
          dstHostId: target.dstHostId,
          dstPath: target.dstPath,
          operation: target.operation,
          strategy,
          overrides,
        },
        csrfToken,
      ),
    throwOnError: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.TRANSFERS] });
      // No success toast. The queue widget in the sidebar is about to show the
      // job with a progress bar, and a toast saying "started" over the top of
      // it is a worse copy of what the operator is already looking at.
      onStarted();
      close();
    },
    onError: (error) => setFailure(error instanceof ApiError ? error.message : "The transfer could not be started."),
  });

  const refusal = plan.error instanceof ApiError ? plan.error.message : null;
  const data = plan.data;

  const conflicting = data?.items.filter((item) => item.conflict) ?? [];
  const clear = data?.items.filter((item) => !item.conflict) ?? [];
  // Conflicts first, always. They are the only rows anybody has to act on, and
  // a selection of a thousand files would otherwise bury three of them.
  const rows = [...conflicting, ...clear];
  const shown = rows.slice(0, RENDER_LIMIT);

  const unanswered = conflicting.filter((item) => (overrides[item.name] ?? strategy) === "ask").length;
  const writing = data ? bytesToWrite(data, strategy, overrides) : 0;
  const noRoom = data?.destination.freeBytes !== null && data !== undefined && writing > data.destination.freeBytes;
  const armed = data !== undefined && !data.truncated && data.items.length > 0 && unanswered === 0 && !noRoom;

  return (
    <>
      <header className="bg-chrome border-line flex h-topbar flex-none items-center gap-2 border-b px-3">
        <span className="text-ink-label font-mono text-xs font-semibold tracking-label">{verb}</span>
        <Endpoint
          host={hosts.find((host) => host.id === target.srcHostId) ?? null}
          path={target.srcPaths.length === 1 ? target.srcPaths[0] : `${target.srcPaths.length} entries`}
        />
        <span
          aria-hidden
          className="text-ink-faint font-mono text-xs"
        >
          →
        </span>
        <Endpoint
          host={hosts.find((host) => host.id === target.dstHostId) ?? null}
          path={target.dstPath}
        />
      </header>

      {refusal !== null && (
        <div className="bg-danger-wash border-danger text-danger-soft mx-3.5 mt-2.5 border px-2.5 py-1.75 font-mono text-cmd/[1.5]">
          {refusal}
        </div>
      )}

      {data?.truncated === true && (
        <div className="bg-danger-wash border-warning text-warning mx-3.5 mt-2.5 border px-2.5 py-1.75 font-mono text-cmd/[1.5]">
          {`This selection holds more than ${data.ceiling.toLocaleString("en-GB")} entries. Narrow it before transferring.`}
        </div>
      )}

      {data !== undefined && conflicting.length > 0 && (
        <div className="border-line flex items-center gap-2 border-b px-3.5 py-2">
          <span className="text-ink-faint font-mono text-2xs tracking-label">
            {`${count(conflicting.length, "conflict")} · answer`}
          </span>
          <fieldset
            aria-label="What to do with conflicts"
            className="border-line-strong flex h-5 overflow-hidden rounded-sm border"
          >
            {STRATEGIES.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={strategy === option.value}
                onClick={() => {
                  setStrategy(option.value);
                  // The blanket answer replaces the per-row ones. Keeping them
                  // would make "overwrite all" mean "overwrite all except the
                  // ones you touched earlier", which is not what it says.
                  setOverrides({});
                }}
                className={`border-line-strong flex items-center border-l px-2.25 font-mono text-xs first:border-l-0 ${
                  strategy === option.value ? `${SELECTED} font-medium` : "text-ink-muted hover:text-ink"
                }`}
              >
                {option.label}
              </button>
            ))}
          </fieldset>
        </div>
      )}

      <div className="border-line max-h-90 flex-1 overflow-y-auto border-b">
        {plan.isPending && <div className="text-ink-faint px-3.5 py-3 font-mono text-xs">walking both trees…</div>}

        {shown.map((item) => (
          <Row
            key={item.name}
            item={item}
            answer={overrides[item.name] ?? strategy}
            onAnswer={(choice) => setOverrides((current) => ({ ...current, [item.name]: choice }))}
          />
        ))}

        {rows.length > shown.length && (
          <p className="text-ink-faint border-raised border-t px-3.5 py-2 font-mono text-2xs">
            {`…and ${(rows.length - shown.length).toLocaleString("en-GB")} more, all without conflicts. They transfer with the rest.`}
          </p>
        )}

        {data?.skippedLinks !== undefined && data.skippedLinks > 0 && (
          <p className="text-warning border-raised border-t px-3.5 py-2 font-mono text-2xs">
            {`${count(data.skippedLinks, "symlink")} under this selection will not be copied.`}
          </p>
        )}
      </div>

      {noRoom && data !== undefined && (
        <div className="bg-danger-wash border-danger text-danger-soft mx-3.5 mt-2.5 border px-2.5 py-1.75 font-mono text-cmd/[1.5]">
          {/* Blocked, not warned about. A transfer that fills the destination's
              root partition is not a thing to let somebody choose by accident. */}
          {`Needs ${formatSize(writing, "file")} and ${formatSize(data.destination.freeBytes ?? 0, "file")} is free at the destination.`}
        </div>
      )}

      {failure !== null && (
        <div className="bg-danger-wash border-danger text-danger-soft mx-3.5 mt-2.5 border px-2.5 py-1.75 font-mono text-cmd/[1.5]">
          {failure}
        </div>
      )}

      <footer className="bg-chrome flex h-11 flex-none items-center gap-2.5 px-3.5">
        <span className="text-ink-muted font-mono text-2xs/none">
          {data === undefined
            ? ""
            : `${count(data.files, "file")} · ${formatSize(writing, "file")}${data.directories > 0 ? ` · ${count(data.directories, "directory", "directories")}` : ""}`}
        </span>
        {data?.destination.freeBytes != null && (
          <span className="text-ink-faint font-mono text-2xs/none">{`${formatSize(data.destination.freeBytes, "file")} free`}</span>
        )}
        <div className="flex-1" />
        {unanswered > 0 && (
          <span className="text-warning font-mono text-2xs/none">{`${count(unanswered, "conflict")} unanswered`}</span>
        )}
        <button
          type="button"
          onClick={close}
          className="border-line-strong text-ink-soft border px-3.5 py-1.75 font-mono text-xs/none"
        >
          cancel
        </button>
        <button
          type="button"
          onClick={() => start.mutate()}
          disabled={!armed || start.isPending}
          className={`${PRESS} disabled:bg-line disabled:text-ink-faint px-3.5 py-1.75 font-mono text-xs/none font-medium disabled:cursor-not-allowed`}
        >
          {start.isPending ? "starting…" : `${verb} ${data ? count(data.items.length, "entry", "entries") : ""}`}
        </button>
      </footer>
    </>
  );
}

/**
 * One end of the transfer, with its host's colour dot.
 *
 * The path falls off the **left**, which is the pane's own breadcrumb rule and
 * matters more here than there: two endpoints of a deep tree share every
 * leading segment, so an ellipsis at the end renders the source and the
 * destination as the same illegible string with an arrow between them. What
 * distinguishes them is the last few segments, so those are what survive.
 *
 * Done with `justify-end` in an overflow-hidden box rather than `truncate`,
 * because CSS has no head-side text-overflow — the same reason `Breadcrumb`
 * does it this way.
 */
function Endpoint({ host, path }: { host: HostView | null; path: string }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      <span
        aria-hidden
        className="size-1.5 flex-none rounded-full"
        style={{ backgroundColor: host?.colour ?? "var(--color-ink-faint)" }}
      />
      <Tooltip content={host ? `${host.label}:${path}` : path}>
        <span className="flex min-w-0 flex-auto justify-end overflow-hidden">
          <span className="text-ink-muted flex-none font-mono text-cmd whitespace-nowrap">
            {host ? `${host.label}:${path}` : path}
          </span>
        </span>
      </Tooltip>
    </span>
  );
}

/**
 * One entry.
 *
 * A conflicting row carries three buttons and a non-conflicting one says so
 * instead — inert rather than absent, because a row with nothing where the
 * controls are on every other row reads as a row that failed to render.
 */
function Row({
  item,
  answer,
  onAnswer,
}: {
  item: PlannedItem;
  answer: ConflictStrategy;
  onAnswer: (choice: ConflictStrategy) => void;
}) {
  return (
    <div className="border-raised grid grid-cols-[auto_1fr_auto_auto] items-center gap-2.5 border-t px-3.5 py-1.5">
      <span className="text-ink-faint w-14 font-mono text-2xs/none">
        {item.kind === "directory" ? "dir" : item.kind}
      </span>
      <span className={`min-w-0 truncate font-mono text-xs/[1.3] ${item.conflict ? "text-warning" : "text-ink-muted"}`}>
        {item.name}
      </span>

      <span className="flex flex-col items-end gap-0.5">
        {/* Always "file": the server already gave a directory a size of zero,
            because a directory's inode is not bytes crossing the wire. Passing
            the entry's own kind would make `formatSize` render a dash for a
            symlink and a "0 B" that reads as a measurement for a folder. */}
        <span className="text-ink-soft font-mono text-xs/none">
          {item.kind === "directory" ? "—" : formatSize(item.bytes, "file")}
        </span>
        {/* The note, whenever there is one. Not `conflict ? note : …`: a
            directory that is already there and merging is not a conflict and
            is very much not absent, and the server's own line says which. */}
        <span className="text-ink-faint font-mono text-2xs/none">
          {item.note || "does not exist at the destination"}
        </span>
      </span>

      {item.conflict ? (
        <span className="flex flex-none gap-0.75">
          {(["overwrite", "skip", "keepBoth"] as const).map((choice) => (
            <button
              key={choice}
              type="button"
              aria-pressed={answer === choice}
              onClick={() => onAnswer(choice)}
              className={`border px-1.5 py-0.5 font-mono text-2xs/none ${
                answer === choice
                  ? "border-accent-soft text-brand bg-accent/20"
                  : "border-line-strong text-ink-faint hover:text-ink-muted"
              }`}
            >
              {choice === "keepBoth" ? "both" : choice}
            </button>
          ))}
        </span>
      ) : (
        <span className="text-ink-faint w-[7.5rem] text-right font-mono text-2xs/none">no conflict</span>
      )}
    </div>
  );
}

/**
 * What will actually be written, given the answers so far.
 *
 * A skipped item moves nothing, so counting it against the free space would
 * block transfers that fit. This is the same arithmetic the server does before
 * it refuses, restated here only so the footer's number and the button's state
 * agree with the refusal the operator would otherwise meet on the next click.
 */
function bytesToWrite(
  plan: TransferPlan,
  strategy: ConflictStrategy,
  overrides: Record<string, ConflictStrategy>,
): number {
  return plan.items.reduce((total, item) => {
    if (item.conflict && (overrides[item.name] ?? strategy) === "skip") return total;
    return total + item.bytes;
  }, 0);
}

function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
