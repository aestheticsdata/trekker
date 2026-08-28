"use client";

import { promptFor, run, who } from "@components/explorer/terminal-runner";
import { useFootSlot } from "@components/shell/foot-slot";
import { ScrollThumbRail, useScrollThumbs } from "@components/ui/scroll-thumbs";
import { PROMPT_ELEVATED_INK } from "@helpers/sudo";
import {
  EMPTY_SCROLLBACK,
  HISTORY_LIMIT,
  helpLines,
  LINE_INK,
  OUTPUT_LIMIT,
  PROMPT_CHAR_INK,
  PROMPT_WHERE_INK,
  PROMPT_WHO_INK,
  parse,
  TERMINAL_BAR,
  TERMINAL_LABEL_INK,
  TERMINAL_OUTPUT_INK,
  TERMINAL_SURFACE,
  TERMINAL_TITLE_INK,
} from "@helpers/terminal";
import { fetchHostSummary } from "@lib/api/hosts";
import { QUERY_KEYS } from "@lib/query/keys";
import { useSudoWindow } from "@lib/query/use-sudo";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { TerminalWorld, Written } from "@components/explorer/terminal-runner";
import type { TerminalLine } from "@helpers/terminal";

/**
 * The terminal, docked at the foot of the window (TRE-35 §3, TRE-85).
 *
 * Not a shell and not pretending to be one. Every line goes through
 * `helpers/terminal.ts`, which either produces one typed intent or refuses with
 * a sentence, and `terminal-runner.ts` turns that intent into the same API call
 * the equivalent button makes. Nothing here assembles a command, and nothing
 * here has a passthrough to add later — the `Intent` union is the whole surface,
 * and widening it means writing a parser.
 *
 * **It has two forms and one input.** Collapsed it is a 28px strip — the prompt
 * row pared down to an invitation: `user@host $` and a blinking stand-in caret
 * (TRE-115), with the cwd and the echo kept for the expanded form. Expanded
 * it is that same row with 198px of panel grown above it. Not two components
 * and not two inputs: the row below is the *same element* in both, so the draft,
 * the caret, the focus and the walk through history survive a toggle without
 * anything being handed over. That is the whole reason `open` is a class on the
 * box and a pair of conditional children, rather than an early return.
 *
 * It lives inside `Explorer` rather than in the shell, and renders through a
 * portal into the row `AppShell` keeps below the status bar (`useFootSlot`).
 * The reason for the first half is the ticket's own: "the terminal is a
 * keyboard interface to the explorer, not an escape hatch out of it" — and
 * moving a pane, rebinding a host and opening a modal are all closures in
 * `Explorer`. A panel owned by the shell would need every one of them lifted
 * out and handed back down, and would still be unable to see `overlayOpen`,
 * which is what stops `⎋` closing a dialogue and the terminal on one keypress.
 * The portal is the second half: 2a draws the strip as the last row of the
 * window, below a status bar this component does not own, and a portal answers
 * that without reopening any of the above.
 */

/** Where the typed history is kept, per tab, which is what "per session" means. */
const HISTORY_KEY = "trekker:terminal-history";

function readHistory(): string[] {
  // A tab with no history and a browser that refuses storage are the same
  // situation from here: an empty list, and the terminal works anyway.
  try {
    const stored = sessionStorage.getItem(HISTORY_KEY);
    if (stored === null) return [];
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function writeHistory(history: readonly string[]): void {
  try {
    sessionStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // Private browsing, a full quota, a locked-down origin. History is a
    // convenience and losing it is not worth a broken keypress.
  }
}

export function TerminalPanel({
  open,
  world,
  hostsPending,
  pending,
  onPendingRun,
  onOpenChange,
}: {
  /**
   * Whether the scrollback is up. The prompt row shows either way.
   *
   * A prop rather than a condition on the mount, so scrollback outlives being
   * put away: `⌥↩` twice is a glance at the panes and back, and a terminal that
   * forgot what it had answered would make `clear` pointless — the buffer would
   * already be empty every time you looked at it. This holds no connection and
   * no timer, so staying mounted costs a collapsed panel nothing.
   */
  open: boolean;
  /** Null while the active pane has no host — everything but `help` needs one. */
  world: TerminalWorld | null;
  /** True while the host list is still in flight, which is a wait rather than a refusal. */
  hostsPending: boolean;
  /**
   * A line the ⌘K palette handed over, or null (TRE-36 §2).
   *
   * It runs exactly as if it had been typed here — echoed at the prompt, kept
   * in the history, and put through the same parser. That is what makes the
   * palette's "nothing matches, ↩ runs it in the terminal instead" an honest
   * offer rather than a second, quieter command path: an unparseable line gets
   * the refusal that lists what this terminal does take, in the place that can
   * show it.
   */
  pending: string | null;
  /** Called the moment the line is taken, so it is never taken twice. */
  onPendingRun: () => void;
  /**
   * Both directions, because the strip now expands as well as collapses: a
   * click on it, and a line submitted from it, both need somewhere for the
   * answer to land.
   */
  onOpenChange: (open: boolean) => void;
}) {
  const [lines, setLines] = useState<readonly TerminalLine[]>([]);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<readonly string[]>(readHistory);
  /**
   * How far back `↑` has walked, or null while the input is the person's own.
   *
   * An index rather than a copy of the line, because `↓` back to the bottom has
   * to return what was being typed before the walk started — which a copy has
   * already overwritten.
   */
  const [walked, setWalked] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const sequence = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const foot = useFootSlot();

  const hostId = world?.host.id ?? null;
  const { open: elevated } = useSudoWindow(hostId);

  // The same query the top bar runs on the active host, so the prompt costs
  // nothing on the host the terminal is standing on.
  const { data: summary } = useQuery({
    queryKey: [QUERY_KEYS.HOST_SUMMARY, hostId],
    queryFn: () => fetchHostSummary(hostId as string),
    enabled: hostId !== null,
    staleTime: 10_000,
    retry: false,
    throwOnError: false,
  });

  const remoteUser = summary?.remoteUser ?? null;
  const echoed = world === null ? "$" : promptFor(world, remoteUser, elevated);

  // The panel is opened by a keypress, so the caret is where the keypress meant
  // to go. Without this the first thing typed lands in the pane's own handler.
  //
  // Only on the way up. Collapsing deliberately does not touch focus — `⌥↩`
  // means "get the scrollback out of my way", not "stop typing", and since
  // TRE-85 the input it would have blurred is still on screen.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Scrollback follows the end. There is no "scrolled up" state to respect the
  // way the live tail has one: lines arrive only in answer to something typed,
  // so the newest line is always the one that was just asked for.
  useEffect(() => {
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [lines, open]);

  // The composited scrollbar's measured half (TRE-113, shared out to every
  // long scroller by TRE-117 — the mechanism is explained where it now
  // lives). The key names what the scrollback's size is a function of: the
  // lines while it is up, nothing while it is down — so reopening measures
  // the fresh element the conditional just mounted.
  useScrollThumbs(bodyRef, open ? lines : null);

  const write = (written: readonly Written[]) => {
    if (written.length === 0) return;
    // Keyed out here, not inside the updater. An updater is not a place to have
    // a side effect and StrictMode calls each one twice — which would mint two
    // keys per line and leave the counter describing a buffer twice the size of
    // the real one. The same trap `use-tail.ts` sidesteps the same way.
    const keyed = written.map((entry) => ({ ...entry, key: sequence.current++ }));
    setLines((current) => {
      const next = [...current, ...keyed];
      return next.length > OUTPUT_LIMIT ? next.slice(-OUTPUT_LIMIT) : next;
    });
  };

  const remember = (line: string) => {
    setHistory((current) => {
      // A line repeated straight after itself is one line of history, which is
      // what makes `↑` useful after a `ls` that was run three times.
      const next = current[current.length - 1] === line ? current : [...current, line];
      const capped = next.length > HISTORY_LIMIT ? next.slice(-HISTORY_LIMIT) : next;
      writeHistory(capped);
      return capped;
    });
  };

  /**
   * Run one line, wherever it came from.
   *
   * It does not touch the input row, deliberately: since TRE-36 a line can also
   * arrive from the ⌘K palette, and clearing the field would throw away a draft
   * somebody had half typed here before reaching for the palette. The ↩ handler
   * clears its own field before calling this, which is where that belongs.
   */
  const submit = async (typed: string) => {
    if (typed.trim().length === 0) return;
    // An answer needs somewhere to land. A line run from the collapsed strip
    // raises the scrollback first rather than writing into a box nobody can
    // see — including the refusal, which is the most likely thing a line typed
    // down here produces.
    onOpenChange(true);
    remember(typed);
    write([{ kind: "echo", text: `${echoed} ${typed}` }]);

    const parsed = parse(typed, { cwd: world?.cwd ?? "/", home: world?.host.homePath ?? "/" });
    if (parsed === null) return;

    if (!parsed.ok) {
      write(
        parsed.hint === undefined
          ? [{ kind: "error", text: parsed.error }]
          : [
              { kind: "error", text: parsed.error },
              { kind: "hint", text: parsed.hint },
            ],
      );
      return;
    }

    if (parsed.intent.kind === "clear") {
      setLines([]);
      return;
    }

    // `help` is the one thing that works with no host, and it has to: it is
    // what an unbound pane's refusal tells you to type. It is also the one
    // intent the runner answers without touching the world, so it is answered
    // here rather than through a hollowed-out one — a stub world would be a
    // second definition of what a host is needed for.
    if (world === null) {
      if (parsed.intent.kind === "help") {
        write(helpLines(parsed.intent.topic).map((text) => ({ kind: "output" as const, text })));
        return;
      }
      write([
        { kind: "error", text: `${parsed.intent.kind}: this pane is not bound to a host` },
        {
          kind: "hint",
          text: hostsPending ? "Still reading the host list." : "Pick one in the sidebar, or `ssh <host>`.",
        },
      ]);
      return;
    }

    setBusy(true);
    try {
      write(await run(parsed.intent, world));
    } finally {
      setBusy(false);
    }
  };

  /**
   * The palette's line, once the panel is up (TRE-36 §2).
   *
   * The ref is not defensive coding: StrictMode mounts an effect, tears it down
   * and mounts it again with the same props, so without a record of what has
   * already been taken the line is echoed and run twice. Cleared when `pending`
   * goes back to null, which is what lets the same command be sent twice in a
   * row — `df` after `df` is an ordinary thing to ask for.
   */
  const taken = useRef<string | null>(null);
  useEffect(() => {
    if (pending === null) {
      taken.current = null;
      return;
    }
    if (taken.current === pending) return;
    taken.current = pending;
    onPendingRun();
    // No `open` guard any more: the panel is mounted whatever it is showing,
    // and `submit` raises the scrollback itself. Waiting for the panel to be up
    // would have meant the palette's line never running while it was down.
    void submit(pending);
    // `submit` is rebuilt every render and closes over nothing this needs to
    // watch; `pending` arriving is the whole event.
  }, [pending, onPendingRun]);

  const walk = (delta: -1 | 1) => {
    if (history.length === 0) return;

    if (walked === null) {
      if (delta === 1) return;
      setDraft(input);
      setWalked(history.length - 1);
      setInput(history[history.length - 1]);
      return;
    }

    const next = walked + delta;
    if (next < 0) return;
    if (next >= history.length) {
      setWalked(null);
      setInput(draft);
      return;
    }
    setWalked(next);
    setInput(history[next]);
  };

  // One render's wait, and only on the very first paint: the row is a callback
  // ref in `AppShell`, so it exists by the time that state has settled. Null
  // rather than a fallback position, because rendering here first would put the
  // strip under the panes for a frame and then move it.
  if (foot === null) return null;

  return createPortal(
    <section
      className={`${TERMINAL_SURFACE} border-line flex flex-none flex-col border-t ${
        open ? "h-terminal" : "h-omnibar cursor-text"
      }`}
      aria-label="Terminal"
    >
      {open && (
        <header
          className={`${TERMINAL_BAR} ${TERMINAL_LABEL_INK} border-line h-termbar flex flex-none items-center gap-2.5 border-b px-2.5 font-mono text-caption leading-none`}
        >
          <span className={`${TERMINAL_TITLE_INK} tracking-label flex-none`}>TERMINAL</span>
          <span className="min-w-0 flex-1 truncate">{world?.host.label ?? "no host"}</span>
          <button
            type="button"
            onClick={() => setLines([])}
            className="flex-none hover:opacity-70"
          >
            clear
          </button>
          {/* `×` rather than `close ⌥↩`: since TRE-85 nothing closes. The panel
            puts its scrollback away and leaves the prompt where it was, and a
            button that said "close" would be describing the old behaviour. The
            chord is still the chord — it is in the strip's own hint below. */}
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="Collapse the terminal"
            className="flex-none hover:opacity-70"
          >
            ×
          </button>
        </header>
      )}

      {open && (
        <div
          ref={bodyRef}
          role="log"
          // `off` for the reason the live tail's is off: the role implies polite,
          // and output that is read aloud as it lands would talk over somebody
          // still typing the next line. Labelled, so it can be read on purpose.
          aria-live="off"
          aria-label="Terminal output"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling box with no other keyboard route has to be focusable, or its content is reachable by pointer alone
          tabIndex={0}
          className={`${TERMINAL_OUTPUT_INK} scroll-composited min-h-0 flex-1 overflow-x-auto overflow-y-auto px-2.5 py-1.75 font-mono text-xs leading-term whitespace-pre`}
        >
          <ScrollThumbRail />
          {lines.length === 0 ? (
            <p className={LINE_INK.quiet}>{EMPTY_SCROLLBACK}</p>
          ) : (
            lines.map((line) => (
              <div
                key={line.key}
                className={LINE_INK[line.kind]}
              >
                {line.text}
              </div>
            ))
          )}
        </div>
      )}

      {/* No punctuation between the prompt's parts: the mockup separates
          `user@host`, the path and the prompt character by a gap rather than a
          `:`, so each is a colour rather than a fragment of one string. The
          joined form still exists — it is what an echoed line keeps, where the
          parts have to survive being copied out. */}
      {/* A `<label>`, and that is load-bearing rather than tidy markup. Every
          press anywhere on this row has to reach the field — 2a says so with
          `cursor: text` — and a `<div>` does the opposite: a mousedown focuses
          the nearest focusable ancestor of what was pressed, and the prompt's
          other four children have none, so pressing the identity, the path, the
          `$`, the hint or the padding between them *clears* focus. The panes
          hold no DOM focus at all, so the app's resting state is `body` and the
          window listener drives them from there — meaning the very next key
          after that stray press is a pane shortcut. That is how a `⌫` aimed at
          this field walked a directory up instead.

          A label's own default action is "focus my control", which is the
          behaviour wanted, from the browser rather than from a `preventDefault`
          racing it. The `aria-label` on the input stays: without it the
          accessible name would become this row's whole text. */}
      <label
        className={`flex items-center gap-2 px-2.5 font-mono text-xs leading-none ${
          open ? "border-line flex-none border-t py-1.5" : "min-h-0 flex-1"
        }`}
      >
        <span className={`${PROMPT_WHO_INK} flex-none font-medium`}>
          {world === null ? "…" : `${who(world, remoteUser)}@${world.host.slug}`}
        </span>
        {/* Only while the scrollback is up. Collapsed, the strip is an
            invitation rather than a report, and a path in it made the row read
            as one more status line under the actual status bar (TRE-115).
            Where you are is the panes' own headline; the prompt repeats it
            once it is a prompt. */}
        {open && <span className={`${PROMPT_WHERE_INK} min-w-0 flex-none truncate`}>{world?.cwd ?? "/"}</span>}
        <span
          aria-hidden
          className={`${elevated ? PROMPT_ELEVATED_INK : PROMPT_CHAR_INK} flex-none font-medium`}
        >
          {elevated ? "#" : "$"}
        </span>
        {/* The blink is what says "command line" from across the room, and the
            collapsed strip had none (TRE-115). A thin bar rather than 2a's
            solid block, deliberately: the field's own caret is a bar, and a
            stand-in should look like the thing it stands in for. Collapsed
            only — focusing the field raises the panel and puts the real caret
            in this exact spot, so the two are never on screen together. */}
        {!open && (
          <span
            aria-hidden
            className="bg-ink animate-prompt-caret h-2.75 w-px flex-none"
          />
        )}
        <input
          ref={inputRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              // One line at a time, and the refusal keeps the draft: a second
              // ↩ once the first has answered runs what is already typed. The
              // field stays live throughout — see `aria-busy` below for why it
              // is guarded here rather than by disabling it.
              if (busy) return;
              const typed = input;
              setInput("");
              setWalked(null);
              setDraft("");
              void submit(typed);
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              walk(-1);
              return;
            }
            if (event.key === "ArrowDown") {
              event.preventDefault();
              walk(1);
              return;
            }
            // `⎋` puts the terminal away, and only from in here (TRE-35 §3).
            // Every dialogue in this app listens for it on the window, and the
            // pane behind reads it as "never mind" to a held clipboard — so a
            // global handler for it would be two things happening on one
            // keypress. Focused, it can only mean one thing, and `useKeyboard`
            // already stands down inside an input, so nothing else sees it.
            //
            // Both halves on one press, and unconditionally: `⎋` means "I am
            // done with the terminal", so it lowers the scrollback *and* hands
            // the keyboard back to the panes. It is `⌥↩` that keeps the caret,
            // because putting the scrollback away is not the same as being
            // finished typing — that is the whole distinction between the two
            // keys, and splitting `⎋` across two presses blurred it.
            if (event.key === "Escape") {
              event.preventDefault();
              onOpenChange(false);
              inputRef.current?.blur();
            }
          }}
          // Never `disabled`, deliberately. A control that becomes disabled is
          // unfocused by the browser there and then, and re-enabling it does
          // not give the focus back — so every command that reached the runner
          // used to cost the caret, and the next one had to start with a
          // click. `aria-busy` says the same thing to a screen reader without
          // taking anything away, and ↩ is refused above.
          aria-busy={busy}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          aria-label="Terminal input"
          // Focus is the one signal that the person has come to the terminal,
          // and every route to it ends here: a press anywhere on the row, the
          // label's own default action, `⌥↩`, or a tab stop. So the panel opens
          // from `onFocus` rather than from a click handler on the row — one
          // place instead of four, and no press that reaches the field by a
          // path nobody thought of can leave it focused inside a strip that
          // never raised itself.
          onFocus={() => onOpenChange(true)}
          // No placeholder, deliberately — the strip used to echo the
          // terminal's last line here, and a row that opens `user@host $` and
          // then prints an old answer reads as a status bar, which is the
          // confusion TRE-115 exists to end. An empty field behind a blinking
          // caret is what "type here" looks like; what the terminal last said
          // is one ⌥↩ away.
          className="text-ink min-w-0 flex-1 bg-transparent outline-none"
        />

        {!open && (
          <span className={`${TERMINAL_LABEL_INK} flex-none text-caption leading-none`}>
            ⌥↩ expand to terminal · ↑ history
          </span>
        )}
      </label>
    </section>,
    foot,
  );
}
