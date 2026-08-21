"use client";

import { promptFor, run, who } from "@components/explorer/terminal-runner";
import { PROMPT_ELEVATED_INK } from "@helpers/sudo";
import {
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

import type { TerminalWorld, Written } from "@components/explorer/terminal-runner";
import type { TerminalLine } from "@helpers/terminal";

/**
 * The terminal, docked under the panes (TRE-35 §3).
 *
 * Not a shell and not pretending to be one. Every line goes through
 * `helpers/terminal.ts`, which either produces one typed intent or refuses with
 * a sentence, and `terminal-runner.ts` turns that intent into the same API call
 * the equivalent button makes. Nothing here assembles a command, and nothing
 * here has a passthrough to add later — the `Intent` union is the whole surface,
 * and widening it means writing a parser.
 *
 * It lives inside `Explorer` rather than in the shell's `strip` slot, which is
 * where the disk-usage bar goes. The reason is the ticket's own: "the terminal
 * is a keyboard interface to the explorer, not an escape hatch out of it" — and
 * moving a pane, rebinding a host and opening a modal are all closures in
 * `Explorer`. A panel in the shell would need every one of them lifted out and
 * handed back down, and would still be unable to see `overlayOpen`, which is
 * what stops `⎋` closing a dialogue and the terminal on one keypress.
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
  onClose,
}: {
  /**
   * Whether the panel is showing.
   *
   * A prop rather than a condition on the mount, so scrollback outlives being
   * put away: `⌥↩` twice is a glance at the panes and back, and a terminal that
   * forgot what it had answered would make `clear` pointless — the buffer would
   * already be empty every time you looked at it. This holds no connection and
   * no timer, so staying mounted costs a closed panel nothing.
   */
  open: boolean;
  /** Null while the active pane has no host — everything but `help` needs one. */
  world: TerminalWorld | null;
  /** True while the host list is still in flight, which is a wait rather than a refusal. */
  hostsPending: boolean;
  onClose: () => void;
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
  // On `open` rather than on mount, because it now stays mounted while closed.
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

  const submit = async () => {
    const typed = input;
    setInput("");
    setWalked(null);
    setDraft("");

    if (typed.trim().length === 0) return;
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

  // Null rather than `hidden`: a closed panel must not be in the tab order or
  // reachable by a screen reader, and it keeps its state either way.
  if (!open) return null;

  return (
    <section
      className={`${TERMINAL_SURFACE} border-line h-terminal flex flex-none flex-col border-t`}
      aria-label="Terminal"
    >
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
        <button
          type="button"
          onClick={onClose}
          className="flex-none hover:opacity-70"
        >
          close ⌥↩
        </button>
      </header>

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
        className={`${TERMINAL_OUTPUT_INK} min-h-0 flex-1 overflow-x-auto overflow-y-auto px-2.5 py-1.75 font-mono text-xs leading-term whitespace-pre`}
      >
        {lines.length === 0 ? (
          <p className={LINE_INK.quiet}>a restricted set, not a shell — `help` lists what it takes</p>
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

      {/* Four children and no punctuation between them: the mockup separates
          `user@host`, the path and the prompt character by a gap rather than a
          `:`, so each is a colour rather than a fragment of one string. The
          joined form still exists — it is what an echoed line keeps, where the
          parts have to survive being copied out. */}
      <div className="border-line flex flex-none items-center gap-2 border-t px-2.5 py-1.5 font-mono text-xs leading-none">
        <span className={`${PROMPT_WHO_INK} flex-none font-medium`}>
          {world === null ? "…" : `${who(world, remoteUser)}@${world.host.slug}`}
        </span>
        <span className={`${PROMPT_WHERE_INK} min-w-0 flex-none truncate`}>{world?.cwd ?? "/"}</span>
        <span
          aria-hidden
          className={`${elevated ? PROMPT_ELEVATED_INK : PROMPT_CHAR_INK} flex-none font-medium`}
        >
          {elevated ? "#" : "$"}
        </span>
        <input
          ref={inputRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void submit();
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
            // `⎋` closes, and only from in here (TRE-35 §3). Every dialogue in
            // this app listens for it on the window, and the pane behind reads
            // it as "never mind" to a held clipboard — so a global handler for
            // it would be two things happening on one keypress. Focused, it can
            // only mean one thing, and `useKeyboard` already stands down inside
            // an input, so nothing else sees it.
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
          disabled={busy}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          aria-label="Terminal input"
          className="text-ink min-w-0 flex-1 bg-transparent outline-none disabled:opacity-60"
        />
      </div>
    </section>
  );
}
