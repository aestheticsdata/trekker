"use client";

import { useAuth } from "@auth/context/AuthContext";
import { ActivityStrip } from "@components/sidebar/activity-strip";
import { Volumes } from "@components/sidebar/volumes";
import { useToast } from "@components/ui/toast";
import { Tooltip } from "@components/ui/tooltip";
import { TransferQueue } from "@components/ui/transfers";
import { VIEW_SLOTS, writeViewSlot } from "@helpers/keys";
import { deleteBookmark, fetchBookmarks } from "@lib/api/bookmarks";
import { fetchHostSummary } from "@lib/api/hosts";
import { QUERY_KEYS } from "@lib/query/keys";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { BookmarkView } from "@lib/api/bookmarks";
import type { HostView } from "@lib/api/hosts";
import type { ReactNode } from "react";

/**
 * The 176px left sidebar (TRE-18 §2, §3), built from the App mockup's markup.
 *
 * Five sections shipped here. VOLUMES was deliberately absent rather than empty
 * — `GET /hosts/:id/summary` carries uptime, load, memory and ping and no disk
 * data at all, and the rule is to hide a panel rather than fake it — and
 * arrived with TRE-33 once `GET /hosts/:id/disks` existed to fill it. VIEWS
 * arrived the same way with TRE-37, once there was a `Views` endpoint to fill
 * it, and it goes at the top as the mockup orders it: a view chooses both
 * machines, so it sits above the section that chooses one.
 *
 * ACTIVITY was absent for a harder reason — nothing in the API wrote an
 * ActivityLog row, and the vocabulary of `kind` was TRE-30's to define — and
 * arrived with that ticket. TRANSFERS arrived the same way with TRE-23: there
 * was no queue to show until there were jobs to put in one.
 */
export function Sidebar({
  hosts,
  paneHostIds,
  activePane,
  views,
  onBindHost,
  onNavigate,
}: {
  hosts: readonly HostView[];
  /** What each pane is showing, so a row can draw its A and B badges. */
  paneHostIds: readonly [string | null, string | null];
  activePane: 0 | 1;
  /**
   * The saved-views rows (TRE-37 §4), as a node.
   *
   * A slot for the reason the top bar's strip is one: the list compares every
   * view against the layout on screen, and handing this rail the whole layout
   * would re-render five sections and every host's ping on each keystroke.
   */
  views?: ReactNode;
  onBindHost: (pane: 0 | 1, host: HostView) => void;
  onNavigate: (host: HostView, path: string) => void;
}) {
  const { data: bookmarks } = useQuery({
    queryKey: [QUERY_KEYS.BOOKMARKS],
    queryFn: fetchBookmarks,
    staleTime: 60_000,
    throwOnError: false,
  });

  return (
    <aside className="bg-chrome border-line flex w-44 flex-none flex-col border-r">
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-1.75">
        {views && (
          <>
            {/* The range is spelled by the keymap rather than written here, the
                same rule the ⌘K chip follows: a chord moved in `helpers/keys.ts`
                while this said ⌥1–9 would advertise a key that fires nothing. */}
            <Section
              title="VIEWS"
              counter={`${writeViewSlot(VIEW_SLOTS[0])}–${VIEW_SLOTS[VIEW_SLOTS.length - 1]}`}
            >
              {views}
            </Section>

            <Rule />
          </>
        )}

        <Section
          title="SERVERS"
          counter={`${hosts.length} ${hosts.length === 1 ? "host" : "hosts"}`}
        >
          {hosts.map((host) => (
            <ServerRow
              key={host.id}
              host={host}
              here={paneHostIds[activePane] === host.id}
              boundTo={[paneHostIds[0] === host.id, paneHostIds[1] === host.id]}
              onPick={() => onBindHost(activePane, host)}
              onBind={(pane) => onBindHost(pane, host)}
            />
          ))}
          {hosts.length === 0 && <Empty>No hosts yet.</Empty>}
        </Section>

        <Rule />

        {/* Below SERVERS and above FAVOURITES, as the mockup orders them — and
            the order is the meaning again: this section describes the machine
            the section above it selected. */}
        <Section title="VOLUMES">
          <Volumes
            host={hosts.find((host) => host.id === paneHostIds[activePane]) ?? null}
            onNavigate={onNavigate}
          />
        </Section>

        <Rule />

        <Section title="FAVOURITES">
          <Favourites
            hosts={hosts}
            bookmarks={bookmarks ?? []}
            onNavigate={onNavigate}
          />
        </Section>

        <Rule />

        {/* Above ACTIVITY, and the order is the meaning: this section is what
            is happening, the one below it is what happened. A finished transfer
            leaves here and appears there (TRE-24 §3). */}
        <Section title="TRANSFERS">
          <TransferQueue />
        </Section>

        <Rule />

        <Section title="ACTIVITY">
          <ActivityStrip />
        </Section>
      </div>
    </aside>
  );
}

/**
 * One section, and the two inks it draws.
 *
 * The counter used to be `ink-faint`, which is 2a's `#4d7f99` and measures
 * **3.82:1** on this rail's `chrome` ground — under AA, and invisible to
 * `verify:contrast`, which reads class names out of `src/helpers` and cannot
 * see one written inline here. `ink-dim` is the next step up the same ladder
 * and clears at 7.06:1. Lifted in the two primitives TRE-37's VIEWS section
 * renders through; the rest of this file's quiet inks have the same problem and
 * are TRE-81's, along with the hundred-odd elsewhere in the app.
 */
function Section({ title, counter, children }: { title: string; counter?: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-ink-label flex items-baseline px-2.5 pt-1.5 pb-1 font-sans text-caps font-semibold tracking-[0.16em]">
        {title}
        {counter && <span className="text-ink-dim ml-auto font-mono font-normal tracking-normal">{counter}</span>}
      </h2>
      {children}
    </section>
  );
}

function Rule() {
  return (
    <div
      aria-hidden
      className="bg-line mx-2.5 my-1.5 h-px"
    />
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-ink-dim px-2.5 py-1 font-mono text-2xs">{children}</p>;
}

/**
 * One host.
 *
 * Three visual states run independently, which is what the mockup's markup
 * encodes: the row is lit when it is the *active pane's* host (and its left
 * edge takes the host's own colour, not the accent), while the A and B badges
 * say which panes hold it. A host can be lit and bound to neither, or bound to
 * both and lit for whichever pane has the keyboard.
 */
function ServerRow({
  host,
  here,
  boundTo,
  onPick,
  onBind,
}: {
  host: HostView;
  here: boolean;
  boundTo: readonly [boolean, boolean];
  onPick: () => void;
  onBind: (pane: 0 | 1) => void;
}) {
  // Only asked for once the host is on screen, and cached 5s server-side.
  const { data: summary } = useQuery({
    queryKey: [QUERY_KEYS.HOST_SUMMARY, host.id],
    queryFn: () => fetchHostSummary(host.id),
    staleTime: 10_000,
    refetchInterval: 30_000,
    retry: false,
    throwOnError: false,
  });

  return (
    <div
      className={`hover:bg-raised flex h-6 items-center gap-1.75 border-l-2 pr-1.75 pl-2 ${
        here ? "bg-raised" : "border-transparent"
      }`}
      style={here ? { borderLeftColor: host.colour } : undefined}
    >
      <span
        aria-hidden
        className="size-1.5 flex-none rounded-full"
        style={{ backgroundColor: host.colour }}
      />

      <Tooltip content={`Open ${host.label} in the active pane`}>
        <button
          type="button"
          onClick={onPick}
          className={`min-w-0 flex-1 truncate text-left font-mono text-xs ${
            here ? "text-ink font-medium" : "text-ink-soft"
          }`}
        >
          {host.label}
        </button>
      </Tooltip>

      {/* A measurement, so it degrades to a dash rather than vanishing. */}
      <span className="text-ink-dim flex-none font-mono text-caps">
        {summary?.pingMs === null || summary === undefined ? "—" : `${summary.pingMs}ms`}
      </span>

      <span className="flex flex-none gap-0.5">
        {([0, 1] as const).map((pane) => (
          <Tooltip
            key={pane}
            content={`Open ${host.label} in pane ${pane === 0 ? "A" : "B"}`}
          >
            <button
              type="button"
              onClick={() => onBind(pane)}
              aria-pressed={boundTo[pane]}
              className="flex size-3.25 items-center justify-center border font-mono text-[0.5rem] font-semibold"
              style={
                boundTo[pane]
                  ? { backgroundColor: host.colour, color: "var(--color-on-accent)", borderColor: host.colour }
                  : { color: "var(--color-ink-faint)", borderColor: "var(--color-line-strong)" }
              }
            >
              {pane === 0 ? "A" : "B"}
            </button>
          </Tooltip>
        ))}
      </span>
    </div>
  );
}

/**
 * Favourites, grouped by host.
 *
 * Grouped rather than flat because that is what the schema can order:
 * `position` is unique within a host and there is no cross-host ordering to
 * fall back on. A flat list would be showing an order the server never
 * promised.
 */
function Favourites({
  hosts,
  bookmarks,
  onNavigate,
}: {
  hosts: readonly HostView[];
  bookmarks: readonly BookmarkView[];
  onNavigate: (host: HostView, path: string) => void;
}) {
  const { csrfToken } = useAuth();
  const queryClient = useQueryClient();
  const { push } = useToast();

  const remove = useMutation({
    mutationFn: (id: string) => deleteBookmark(id, csrfToken),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.BOOKMARKS] }),
    onError: () => push({ tone: "danger", message: "Could not remove that favourite" }),
  });

  if (bookmarks.length === 0) {
    return <Empty>None yet. Bookmark a directory from a pane.</Empty>;
  }

  return (
    <>
      {hosts.map((host) => {
        const mine = bookmarks.filter((bookmark) => bookmark.hostId === host.id);
        if (mine.length === 0) return null;

        return (
          <div key={host.id}>
            {/* The host is named only when more than one has favourites — a
                single-host install should not read as a grouped list. */}
            {hosts.filter((candidate) => bookmarks.some((b) => b.hostId === candidate.id)).length > 1 && (
              <p className="text-ink-faint flex items-center gap-1.5 px-2.5 pt-1 pb-0.5 font-mono text-caps">
                <span
                  aria-hidden
                  className="size-1 flex-none rounded-full"
                  style={{ backgroundColor: host.colour }}
                />
                {host.label}
              </p>
            )}

            {mine.map((bookmark) => (
              <div
                key={bookmark.id}
                className="hover:bg-raised group flex items-center gap-1.5 pr-1 pl-2.5"
              >
                <Tooltip content={bookmark.path}>
                  <button
                    type="button"
                    onClick={() => onNavigate(host, bookmark.path)}
                    className="flex min-w-0 flex-1 flex-col items-start py-0.75 text-left"
                  >
                    <span className="text-ink-soft w-full truncate font-mono text-xs">{bookmark.label}</span>
                    {bookmark.hint && (
                      <span className="text-ink-dim w-full truncate font-mono text-caps">{bookmark.hint}</span>
                    )}
                  </button>
                </Tooltip>
                <Tooltip content="Remove">
                  <button
                    type="button"
                    onClick={() => remove.mutate(bookmark.id)}
                    aria-label={`Remove ${bookmark.label} from favourites`}
                    className="text-ink-dim hover:text-danger-soft flex-none px-1 font-mono text-2xs opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    ✕
                  </button>
                </Tooltip>
              </div>
            ))}
          </div>
        );
      })}
    </>
  );
}
