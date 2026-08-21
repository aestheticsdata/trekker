"use client";

import { useAuth } from "@auth/context/AuthContext";
import { ContextMenu } from "@components/ui/context-menu";
import { useToast } from "@components/ui/toast";
import { VIEW_SLOTS, writeViewSlot } from "@helpers/keys";
import { freeSlot, isDirty } from "@helpers/views";
import { ApiError } from "@lib/api/client";
import { createView, deleteView, updateView } from "@lib/api/views";
import { QUERY_KEYS } from "@lib/query/keys";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { MenuRow } from "@components/shell/actions";
import type { ViewSlot } from "@helpers/keys";
import type { Point } from "@helpers/menu";
import type { SavedView, ViewLayout } from "@schemas/layout";

/**
 * What can be done to one saved view (TRE-37 §4).
 *
 * The same five rows from both entry points, in `ContextMenu` — the panel the
 * listing already uses, which is why that component now takes a `MenuEntry`
 * rather than an `Action`. A second menu written beside it would be a second
 * keyboard, a second disabled treatment and a second set of paddings.
 *
 * The writes live here rather than in the caller because this is where they are
 * asked for, and because each one has something to say afterwards: a duplicate
 * arrives without a chord, an update clears the dot, and a delete cannot be
 * undone. The list is invalidated after every one of them — the server settles
 * the shortcut, so guessing at the new list on this side would mean guessing at
 * which other view just lost `⌥3`.
 */

/** The ids this menu dispatches. Local to the file: no registry has these. */
const RESTORE = "view.restore";
const UPDATE = "view.update";
const RENAME = "view.rename";
const DUPLICATE = "view.duplicate";
const DELETE = "view.delete";

export function ViewMenu({
  view,
  views,
  point,
  current,
  onRestore,
  onRename,
  onAdopt,
  onClose,
}: {
  view: SavedView;
  /** All of them, so a duplicate can be given a chord nobody is holding. */
  views: readonly SavedView[];
  point: Point;
  /** The layout on screen, which is what "update from current" writes. */
  current: ViewLayout;
  onRestore: () => void;
  onRename: () => void;
  /**
   * "Update from current" succeeded, so this view now *is* what is on screen.
   *
   * Reported up rather than assumed, because adopting it is the caller's state:
   * overwriting `log triage` while standing in `deploy` makes `log triage` the
   * view you are in, and leaving `deploy` lit would have the strip naming an
   * arrangement that is no longer on screen.
   */
  onAdopt: () => void;
  onClose: () => void;
}) {
  const { csrfToken } = useAuth();
  const { push } = useToast();
  const queryClient = useQueryClient();

  const refresh = () => queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.VIEWS] });
  const failed = (error: unknown, what: string) =>
    push({ tone: "danger", message: what, detail: error instanceof ApiError ? error.message : undefined });

  const overwrite = useMutation({
    mutationFn: () => updateView(view.id, { layout: current }, csrfToken),
    throwOnError: false,
    onSuccess: async () => {
      await refresh();
      onAdopt();
      push({ tone: "success", message: `${view.name} updated`, detail: "from what is on screen" });
    },
    onError: (error) => failed(error, `Could not update ${view.name}`),
  });

  const duplicate = useMutation({
    mutationFn: () => {
      // A copy with no chord unless one is going spare. Inheriting the original's
      // would take it off the original — the server moves a claimed slot rather
      // than refusing — and a duplicate silently stealing `⌥3` from the view it
      // was copied from is the worst possible reading of "duplicate".
      const slot: ViewSlot | null = freeSlot(
        views.map((candidate) => candidate.slot),
        VIEW_SLOTS,
      );
      return createView(
        { name: copyName(view.name, views), slot, layout: view.layout, hostLabels: view.hostLabels },
        csrfToken,
      );
    },
    throwOnError: false,
    onSuccess: async ({ view: made }) => {
      await refresh();
      push({
        tone: "success",
        message: `${made.name} saved`,
        detail: made.slot === null ? "no shortcut free" : writeViewSlot(made.slot),
      });
    },
    onError: (error) => failed(error, `Could not duplicate ${view.name}`),
  });

  const remove = useMutation({
    mutationFn: () => deleteView(view.id, csrfToken),
    throwOnError: false,
    onSuccess: async () => {
      await refresh();
      push({ tone: "info", message: `${view.name} deleted` });
    },
    onError: (error) => failed(error, `Could not delete ${view.name}`),
  });

  const rows: readonly MenuRow[] = [
    { id: RESTORE, label: "Restore", hint: view.slot === null ? undefined : writeViewSlot(view.slot) },
    {
      id: UPDATE,
      label: "Update from current",
      // Only ever dead for the view actually on screen, and then only because
      // there is nothing to write. Any other view is a perfectly good thing to
      // overwrite with what is showing.
      unavailableReason: isDirty(view.layout, current) ? undefined : "This is already what is on screen",
    },
    { id: RENAME, label: "Rename…" },
    { id: DUPLICATE, label: "Duplicate" },
    { rule: true },
    { id: DELETE, label: "Delete view", danger: true },
  ];

  return (
    <ContextMenu
      point={point}
      label={view.name}
      rows={rows}
      onClose={onClose}
      onChoose={(id) => {
        onClose();
        switch (id) {
          case RESTORE:
            onRestore();
            return;
          case UPDATE:
            overwrite.mutate();
            return;
          case RENAME:
            onRename();
            return;
          case DUPLICATE:
            duplicate.mutate();
            return;
          case DELETE:
            remove.mutate();
            return;
          default:
            return;
        }
      }}
    />
  );
}

/**
 * `deploy` → `deploy copy` → `deploy copy 2`.
 *
 * The name is unique per account in the database, so a duplicate that collided
 * would come back a 409 with nothing useful to say. Counting up here means the
 * second copy is made rather than refused, which is what pressing "duplicate"
 * twice obviously means.
 */
function copyName(name: string, views: readonly SavedView[]): string {
  const taken = new Set(views.map((view) => view.name));
  const base = `${name} copy`.slice(0, 64);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base} ${n}`.slice(0, 64);
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}
