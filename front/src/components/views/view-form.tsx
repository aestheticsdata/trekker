"use client";

import { useAuth } from "@auth/context/AuthContext";
import { Overlay } from "@components/ui/overlay";
import { useToast } from "@components/ui/toast";
import { Tooltip } from "@components/ui/tooltip";
import { VIEW_SLOTS, writeViewSlot } from "@helpers/keys";
import { PRESS, SELECTED } from "@helpers/press";
import {
  describeLayout,
  describePane,
  FORM_LABEL_INK,
  FORM_QUIET_INK,
  freeSlot,
  narrow,
  PANE_KEYS,
  suggestName,
} from "@helpers/views";
import { ApiError } from "@lib/api/client";
import { createView, updateView } from "@lib/api/views";
import { QUERY_KEYS } from "@lib/query/keys";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import type { ViewSlot } from "@helpers/keys";
import type { Keeps } from "@helpers/views";
import type { HostView } from "@lib/api/hosts";
import type { SavedView, ViewLayout } from "@schemas/layout";

/**
 * Saving a layout, and editing one that is saved (TRE-37 §4).
 *
 * One component for both, the way `create-modal` serves a directory and a file:
 * the two differ in a title, a verb and whether there is an id to PATCH.
 *
 * Centred rather than pinned to the top, unlike the ⌘K palette. 2a drops every
 * one of its panels 76–106px from the top edge and this app has already
 * overruled that for every dialogue it ships — a dialogue is a thing to read
 * and answer, and `Overlay`'s own note says the palette is the exception
 * because it is a thing to type into while a list moves under the cursor.
 *
 * The preview is not decoration. What a view stores is invisible by definition
 * — it is what the app will look like at some point in the future — and the
 * two checkboxes below it change it. Reading back both panes, their sorts and
 * the arrangement is the only way to see what the button is about to promise.
 */
export function ViewForm({
  view,
  views,
  current,
  hosts,
  onClose,
  onSaved,
}: {
  /** The view being edited, or null when this is saving what is on screen. */
  view: SavedView | null;
  /** All of them: for the name check, and for what each shortcut is holding. */
  views: readonly SavedView[];
  /** The layout on screen. What a new view stores, and what a rename must not touch. */
  current: ViewLayout;
  hosts: readonly HostView[];
  onClose: () => void;
  /** The view that was written, so the caller can make it the active one. */
  onSaved: (view: SavedView) => void;
}) {
  return (
    <Overlay
      label={view ? `Edit the view ${view.name}` : "Save this layout as a view"}
      onClosed={onClose}
      panelClassName="bg-app border-line-strong flex w-full max-w-[33.75rem] flex-col overflow-hidden rounded-sm border shadow-2xl"
    >
      {(close) => (
        <FormPanel
          view={view}
          views={views}
          current={current}
          hosts={hosts}
          close={close}
          onSaved={onSaved}
        />
      )}
    </Overlay>
  );
}

function FormPanel({
  view,
  views,
  current,
  hosts,
  close,
  onSaved,
}: {
  view: SavedView | null;
  views: readonly SavedView[];
  current: ViewLayout;
  hosts: readonly HostView[];
  close: () => void;
  onSaved: (view: SavedView) => void;
}) {
  const { csrfToken } = useAuth();
  const { push } = useToast();
  const queryClient = useQueryClient();

  const labelOf = (hostId: string | null) => hosts.find((host) => host.id === hostId)?.label ?? null;
  const colourOf = (hostId: string | null) => hosts.find((host) => host.id === hostId)?.colour ?? null;

  /**
   * Editing an existing view leaves its layout alone.
   *
   * "Rename…" and "Update from current" are two entries in the menu and they
   * have to stay two things. A rename that also wrote the current layout would
   * silently do the second one, and the difference between them is exactly what
   * the dirty dot is showing.
   */
  const [name, setName] = useState(() => view?.name ?? suggestName(current, labelOf).slice(0, 64));
  const [slot, setSlot] = useState<ViewSlot | null>(
    () =>
      view?.slot ??
      freeSlot(
        views.map((candidate) => candidate.slot),
        VIEW_SLOTS,
      ),
  );
  const [keeps, setKeeps] = useState<Keeps>({ sorts: true, layout: true });
  const [failure, setFailure] = useState<string | null>(null);

  // What the button is actually about to write, which is also what the preview
  // below draws — one value, so the two can never describe different things.
  const layout = view ? view.layout : narrow(current, keeps);

  const typed = name.trim();
  const collides = views.some((candidate) => candidate.id !== view?.id && candidate.name === typed);
  const problem = typed === "" ? null : collides ? "A view of that name already exists." : null;

  /** Which view is about to lose this chord — the sentence, before the write. */
  const takenFrom = slot === null ? null : (views.find((c) => c.id !== view?.id && c.slot === slot) ?? null);

  const save = useMutation({
    mutationFn: () => {
      setFailure(null);
      const hostLabels = Object.fromEntries(
        PANE_KEYS.flatMap((pane) => {
          const host = layout[pane].host;
          const label = labelOf(host);
          return host === null || label === null ? [] : [[host, label] as const];
        }),
      );
      return view
        ? updateView(view.id, { name: typed, slot, hostLabels }, csrfToken)
        : createView({ name: typed, slot, layout, hostLabels }, csrfToken);
    },
    throwOnError: false,
    onSuccess: async ({ view: written, displaced }) => {
      await queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.VIEWS] });
      onSaved(written);
      push({
        tone: "success",
        message: `${written.name} ${view ? "updated" : "saved"}`,
        // The server settles the shortcut, so this is what actually happened
        // rather than what was asked for.
        detail: displaced
          ? `${written.slot === null ? "shortcut" : writeViewSlot(written.slot)} taken from ${displaced.name}`
          : written.slot === null
            ? undefined
            : writeViewSlot(written.slot),
      });
      close();
    },
    onError: (error) => {
      setFailure(error instanceof ApiError ? error.message : "The view could not be saved.");
    },
  });

  const ready = typed !== "" && problem === null && !save.isPending;

  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);

  return (
    <>
      <header className="bg-line border-line-strong flex h-topbar flex-none items-center gap-2.25 border-b px-3">
        <span className="text-ink font-mono text-xs font-semibold tracking-label">
          {view ? "edit view" : "save view"}
        </span>
        <span className="text-ink-muted min-w-0 truncate font-mono text-2xs">a named snapshot of both panes</span>
        <div className="flex-1" />
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

      <div className="px-3.5 pt-3.25 pb-2.5">
        <div className="mb-1.25 flex items-baseline justify-between gap-2">
          <span className={`${FORM_LABEL_INK} font-sans text-3xs/none font-medium tracking-[0.12em] uppercase`}>
            name
          </span>
          {/* Always rendered, so nothing below it moves when a problem appears
              — the rule the auth screens set. */}
          <span
            role="alert"
            className="text-danger-soft min-w-0 truncate font-mono text-2xs/none"
          >
            {problem ?? " "}
          </span>
        </div>

        <input
          ref={field}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && ready) save.mutate();
          }}
          maxLength={64}
          aria-label="View name"
          className={`bg-chrome text-ink w-full border px-2.5 py-2 font-mono text-sm/none ${
            problem ? "border-danger" : "border-accent"
          }`}
        />

        <div
          className={`${FORM_LABEL_INK} mt-3 mb-1.25 font-sans text-3xs/none font-medium tracking-[0.12em] uppercase`}
        >
          shortcut
        </div>
        <div className="flex flex-wrap gap-1">
          {VIEW_SLOTS.map((candidate) => (
            <SlotButton
              key={candidate}
              label={writeViewSlot(candidate)}
              held={views.find((c) => c.id !== view?.id && c.slot === candidate)?.name ?? null}
              on={slot === candidate}
              onPick={() => setSlot(candidate)}
            />
          ))}
          <SlotButton
            label="none"
            held={null}
            on={slot === null}
            onPick={() => setSlot(null)}
          />
        </div>
        {/* Said here rather than only in the toast afterwards: moving somebody's
            shortcut is a decision, and a decision reported after the fact is an
            apology. */}
        <p className={`${FORM_QUIET_INK} mt-1.5 h-3 font-mono text-2xs/none`}>
          {takenFrom ? `takes ${writeViewSlot(slot as ViewSlot)} from ${takenFrom.name}` : " "}
        </p>
      </div>

      <div className="border-line border-y">
        {PANE_KEYS.map((pane) => {
          const described = describePane(layout[pane], labelOf);
          return (
            <PreviewRow
              key={pane}
              term={`pane ${pane.toUpperCase()}`}
              colour={colourOf(layout[pane].host)}
              value={described.where}
              detail={described.sorted}
            />
          );
        })}
        <PreviewRow
          term="layout"
          colour={null}
          value={describeLayout(layout).how}
          detail={describeLayout(layout).filter}
        />
      </div>

      {/* Only on a new view. Editing one cannot change what it stores — that is
          "Update from current", which is a different entry doing a different
          thing, and a checkbox here would make a rename able to do it by
          accident. */}
      {view === null && (
        <div className="flex gap-4 px-3.5 py-2.75">
          <Check
            label="sort order & glob filter"
            on={keeps.sorts}
            onToggle={() => setKeeps({ ...keeps, sorts: !keeps.sorts })}
          />
          <Check
            label="layout, inspector & heat map"
            on={keeps.layout}
            onToggle={() => setKeeps({ ...keeps, layout: !keeps.layout })}
          />
        </div>
      )}

      {failure && (
        <div className="bg-danger-wash border-danger text-danger-soft mx-3.5 mb-2.5 border px-2.5 py-1.75 font-mono text-cmd/[1.5]">
          {failure}
        </div>
      )}

      <footer className="bg-chrome border-line flex h-11 flex-none items-center gap-2 border-t px-3.5">
        {/* 2a says "stored on this machine", which was true of localStorage and
            is the thing this ticket changed. */}
        <span className="text-ink-muted font-mono text-2xs/none">on your account, on every browser</span>
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
          onClick={() => save.mutate()}
          disabled={!ready}
          className={`${PRESS} disabled:bg-line disabled:text-ink-faint px-3.5 py-1.75 font-mono text-xs/none font-medium disabled:cursor-not-allowed`}
        >
          {save.isPending ? "saving…" : view ? "update view" : "save view"}
        </button>
      </footer>
    </>
  );
}

/**
 * One shortcut in the picker.
 *
 * A slot another view is holding is offered rather than disabled, because
 * taking it is a thing the operator is entitled to do and the server implements
 * — it moves. What it must not be is a surprise, so the tooltip names the
 * holder and the line under the row says what pressing save will do.
 */
function SlotButton({
  label,
  held,
  on,
  onPick,
}: {
  label: string;
  held: string | null;
  on: boolean;
  onPick: () => void;
}) {
  return (
    <Tooltip content={held === null ? `Use ${label}` : `${label} is ${held}'s — this takes it`}>
      <button
        type="button"
        onClick={onPick}
        aria-pressed={on}
        className={`border px-2 py-1.25 font-mono text-2xs/none ${
          on ? `${SELECTED} border-accent-soft` : "border-line-strong text-ink-muted hover:bg-raised"
        }`}
      >
        {label}
        {held !== null && !on && (
          <span
            aria-hidden
            className="text-ink-dim ml-1"
          >
            ·
          </span>
        )}
      </button>
    </Tooltip>
  );
}

/** One line of the preview: what a pane is on, or how the app is arranged. */
function PreviewRow({
  term,
  colour,
  value,
  detail,
}: {
  term: string;
  colour: string | null;
  value: string;
  detail: string;
}) {
  return (
    <div className="border-raised flex items-center gap-2.25 border-t px-3.5 py-1.75 first:border-t-0">
      <span
        className={`${FORM_LABEL_INK} w-9.5 flex-none font-sans text-3xs/none font-medium tracking-[0.1em] uppercase`}
      >
        {term}
      </span>
      <span
        aria-hidden
        className={`size-1.5 flex-none rounded-full ${colour === null ? "bg-accent-soft" : ""}`}
        style={colour === null ? undefined : { backgroundColor: colour }}
      />
      <span className="min-w-0">
        <span className="text-ink block truncate font-mono text-xs/[1.35]">{value}</span>
        <span className={`${FORM_QUIET_INK} block truncate font-mono text-caption/[1.35]`}>{detail}</span>
      </span>
    </div>
  );
}

/**
 * 2a's checkbox: a 12px box with a tick, and the label beside it.
 *
 * A `button` with `aria-pressed` rather than a `label` around an `input`,
 * because the base layer gives a button its pointer cursor and gives nothing to
 * a label — one declaration for every control in the app rather than a
 * `cursor-pointer` on this one (TRE-44's rule, in `globals.css`).
 */
function Check({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      className="flex items-center gap-1.5"
    >
      <span
        aria-hidden
        className={`flex size-3 flex-none items-center justify-center border font-mono text-3xs/none font-semibold ${
          on ? `${SELECTED} border-accent-soft` : "bg-chrome border-line-strong"
        }`}
      >
        {on ? "✓" : ""}
      </span>
      <span className="text-ink-soft font-mono text-2xs whitespace-nowrap">{label}</span>
    </button>
  );
}
