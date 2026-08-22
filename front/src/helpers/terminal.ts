/**
 * The terminal's parser (TRE-35 §1): a typed line in, a structured intent out.
 *
 * **The typed string is never forwarded anywhere.** Not to a shell, not to the
 * API, not into a command built by concatenation. What leaves this file is one
 * of the `Intent` shapes below, and every field in them is a value the caller
 * puts into a typed API call it was already making for the equivalent button.
 * That is the whole security design, and it is why this is a parser rather than
 * a sanitiser: there is no string to sanitise on the far side, because no
 * string crosses.
 *
 * It follows that the injection cases have no privileged path to close. `ls;
 * rm -rf /` cannot run a second command because nothing here can express two
 * commands — the return type has room for one. Backticks and `$(…)` cannot
 * substitute because nothing substitutes. They are refused anyway, with a
 * sentence, because a line that silently listed a file called `;` would leave
 * the reader believing something else had happened.
 *
 * Here rather than in the component so `pnpm verify:terminal` can drive it
 * without a browser: the injection table is the test that matters, and it is
 * pure input and output.
 */

/** Everything the terminal answers to. Adding one means adding a parser. */
export const COMMANDS = [
  "ls",
  "cd",
  "pwd",
  "du",
  "df",
  "chmod",
  "rm",
  "hostname",
  "whoami",
  "ssh",
  "clear",
  "help",
] as const;

export type CommandName = (typeof COMMANDS)[number];

/**
 * What the runner is asked to do.
 *
 * Deliberately not "a command and its arguments". Every path here is already
 * absolute and already resolved against the pane, so the runner has no parsing
 * left to do and no opportunity to do it differently from this file.
 */
export type Intent =
  | { kind: "ls"; path: string }
  | { kind: "cd"; path: string }
  | { kind: "cdBack" }
  | { kind: "pwd" }
  | { kind: "du"; path: string }
  | { kind: "df" }
  /** Opens the permissions modal. Never applies anything itself. */
  | { kind: "chmod"; mode: string; targets: readonly string[] }
  /** Opens the delete modal, which is where the typed confirmation lives. */
  | { kind: "rm"; targets: readonly string[]; recursive: boolean }
  | { kind: "hostname" }
  | { kind: "whoami" }
  | { kind: "ssh"; host: string }
  | { kind: "clear" }
  | { kind: "help"; topic: CommandName | null };

export type Parsed = { ok: true; intent: Intent } | { ok: false; error: string; hint?: string };

/** What the parser needs to know about where it is standing. */
export interface TerminalContext {
  /** The active pane's directory. Relative paths resolve against it. */
  cwd: string;
  /** The host's home, which is where a bare `cd` goes. */
  home: string;
}

/**
 * The characters a shell would read as structure, and this does not.
 *
 * Refused outside quotes rather than treated as ordinary filename characters,
 * even though every one of them is legal in a POSIX filename. The reason is
 * that the person typing `ls | grep foo` believes something is about to be
 * piped, and a listing of a file named `|` does not correct that belief. Inside
 * quotes they are literal, so a file genuinely called `a;b` is still reachable.
 */
const OPERATORS = new Set([";", "|", "&", "`", "$", "(", ")", "<", ">", "\n", "\r"]);

const RESTRICTED = "Trekker's terminal is a restricted set, not a shell. `help` lists what it takes.";

export function parse(line: string, context: TerminalContext): Parsed | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  const tokens = tokenise(trimmed);
  if (!tokens.ok) return { ok: false, error: tokens.error, hint: tokens.hint };

  const [name, ...rest] = tokens.words;
  if (!isCommand(name)) {
    return { ok: false, error: `${name}: command not found`, hint: RESTRICTED };
  }

  return parseCommand(name, rest, context);
}

// ------------------------------------------------------------------ the words

interface Tokens {
  ok: true;
  words: string[];
}
interface TokenError {
  ok: false;
  error: string;
  hint?: string;
}

/**
 * Words, separated by whitespace, with both quote styles taken literally.
 *
 * **Neither quote expands anything**, which is the one place this deliberately
 * differs from a shell: `"$HOME"` is the five characters, because there are no
 * variables to expand and pretending otherwise would be worse than not
 * offering them. There is no backslash escape either, and that is not a gap —
 * a backslash is a legal character in a filename, so treating it literally is
 * the more correct of the two readings.
 */
function tokenise(line: string): Tokens | TokenError {
  const words: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;

  for (const character of line) {
    if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
      started = true;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }

    if (character === " " || character === "\t") {
      if (started) words.push(current);
      current = "";
      started = false;
      continue;
    }

    if (OPERATORS.has(character)) {
      return {
        ok: false,
        error: `${character} is not something this terminal does`,
        hint: "No pipes, redirection, substitution or chaining. One command, and it runs through the same guards the buttons do. Quote it — 'a;b' — to mean it as part of a name.",
      };
    }

    current += character;
    started = true;
  }

  if (quote !== null) return { ok: false, error: `unbalanced ${quote} quote` };
  if (started) words.push(current);
  return { ok: true, words };
}

function isCommand(word: string): word is CommandName {
  return (COMMANDS as readonly string[]).includes(word);
}

// --------------------------------------------------------------- the commands

function parseCommand(name: CommandName, args: readonly string[], context: TerminalContext): Parsed {
  switch (name) {
    case "ls": {
      // `-l` and `-a` are accepted and ignored rather than refused: the listing
      // always shows the long form and always shows everything, so both flags
      // ask for what is already on screen. Refusing them would be pedantry
      // aimed at muscle memory.
      const rest = withoutFlags(args, ["-l", "-a", "-la", "-al", "-lah", "-alh"]);
      if (!rest.ok) return refuseFlag(name, rest.flag);
      if (rest.words.length > 1) return tooMany(name, "one directory");
      return { ok: true, intent: { kind: "ls", path: resolve(rest.words[0] ?? ".", context) } };
    }

    case "cd": {
      if (args.length === 0) return { ok: true, intent: { kind: "cd", path: context.home } };
      if (args.length > 1) return tooMany(name, "one directory");
      // `cd -` is the pane's own back button, which is the honest mapping: the
      // pane keeps a history and this is a keyboard route into it.
      if (args[0] === "-") return { ok: true, intent: { kind: "cdBack" } };
      return { ok: true, intent: { kind: "cd", path: resolve(args[0], context) } };
    }

    case "du": {
      const rest = withoutFlags(args, ["-h", "-s", "-sh", "-hs"]);
      if (!rest.ok) return refuseFlag(name, rest.flag);
      if (rest.words.length > 1) return tooMany(name, "one directory");
      return { ok: true, intent: { kind: "du", path: resolve(rest.words[0] ?? ".", context) } };
    }

    case "chmod": {
      if (args.length < 2) {
        return { ok: false, error: "chmod needs a mode and something to apply it to", hint: "chmod 644 notes.txt" };
      }
      const [mode, ...targets] = args;
      // Octal only. The modal speaks octal and symbolic modes are a second
      // grammar to get wrong — and this opens the modal rather than applying
      // anything, so the place to type `u+x` is the place that shows what it
      // would do.
      if (!/^[0-7]{3,4}$/.test(mode)) {
        return {
          ok: false,
          error: `${mode} is not an octal mode`,
          hint: "Three or four octal digits — 644, 0755, 2775.",
        };
      }
      return { ok: true, intent: { kind: "chmod", mode, targets: targets.map((t) => resolve(t, context)) } };
    }

    case "rm": {
      const rest = withoutFlags(args, ["-r", "-f", "-rf", "-fr", "-R"]);
      if (!rest.ok) return refuseFlag(name, rest.flag);
      if (rest.words.length === 0) return { ok: false, error: "rm needs something to remove" };
      // `-f` is parsed and then ignored, deliberately. It means "do not ask" in
      // every shell, and here the asking is the feature: this opens the modal
      // with its typed confirmation whatever the flags said (TRE-25).
      const recursive = args.some((argument) => /^-[a-z]*r[a-z]*$/i.test(argument));
      return { ok: true, intent: { kind: "rm", targets: rest.words.map((t) => resolve(t, context)), recursive } };
    }

    case "ssh": {
      if (args.length !== 1) return { ok: false, error: "ssh takes one host", hint: "ssh web-01" };
      return { ok: true, intent: { kind: "ssh", host: args[0] } };
    }

    case "help": {
      if (args.length === 0) return { ok: true, intent: { kind: "help", topic: null } };
      if (args.length > 1) return tooMany(name, "one command");
      if (!isCommand(args[0])) return { ok: false, error: `${args[0]}: command not found`, hint: RESTRICTED };
      return { ok: true, intent: { kind: "help", topic: args[0] } };
    }

    // The four that take nothing at all. Saying so is better than ignoring the
    // argument somebody bothered to type.
    case "pwd":
    case "df":
    case "hostname":
    case "whoami":
    case "clear":
      if (args.length > 0) return tooMany(name, "nothing");
      return { ok: true, intent: { kind: name } };
  }
}

interface FlagsStripped {
  ok: true;
  words: string[];
}
interface FlagRefused {
  ok: false;
  flag: string;
}

/** Splits the known flags off the front, and names the first unknown one. */
function withoutFlags(args: readonly string[], allowed: readonly string[]): FlagsStripped | FlagRefused {
  const words: string[] = [];
  for (const argument of args) {
    if (!argument.startsWith("-") || argument === "-") {
      words.push(argument);
      continue;
    }
    if (!allowed.includes(argument)) return { ok: false, flag: argument };
  }
  return { ok: true, words };
}

function refuseFlag(name: CommandName, flag: string): Parsed {
  return {
    ok: false,
    error: `${name}: ${flag} is not one of the flags this takes`,
    hint: `help ${name}`,
  };
}

function tooMany(name: CommandName, takes: string): Parsed {
  return { ok: false, error: `${name} takes ${takes}` };
}

// ------------------------------------------------------------------- the paths

/**
 * A typed path, as an absolute one.
 *
 * `.` and `..` are resolved here, lexically, which is the same thing the `..`
 * row in the listing already does through `parentPath`. It is not what a host
 * would do across a symlink — and it does not have to be, because the resolved
 * string is then sent to the API, whose guard runs it through `realpath` on the
 * host and refuses it there if it leaves the roots (TRE-11). This only has to
 * produce a well-formed absolute path; deciding whether it is *allowed* is
 * somewhere else on purpose.
 */
export function resolve(argument: string, context: TerminalContext): string {
  // Segments rather than `joinPath`/`parentPath` from `@helpers/listing`, and
  // it is not a second copy of them: this is one walk that applies their rule
  // — split, drop the empties, pop on `..` — once, instead of rebuilding and
  // re-splitting a string per segment. It also leaves this file importing
  // nothing, which is what lets `pnpm verify:terminal` run it through Node,
  // where a tsconfig path alias resolves to nothing at all.
  const segments = argument.startsWith("/") ? [] : context.cwd.split("/").filter(Boolean);

  for (const segment of argument.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return `/${segments.join("/")}`;
}

/** The prompt, as the mockup writes it: `user@host:/path$`, `#` when elevated. */
export function prompt(user: string, host: string, path: string, elevated: boolean): string {
  return `${user}@${host}:${path}${elevated ? "#" : "$"}`;
}

/** One line of `help`, and the source of the per-command topic too. */
export const USAGE: Readonly<Record<CommandName, string>> = {
  ls: "ls [dir] — list a directory in the active pane's listing",
  cd: "cd [dir] — move the active pane. `cd -` goes back, bare `cd` goes home",
  pwd: "pwd — print the active pane's directory",
  du: "du [dir] — scan disk usage, the same walk the strip runs",
  df: "df — filesystems on this host, as the sidebar shows them",
  chmod: "chmod <mode> <path…> — opens the permissions modal, pre-filled",
  rm: "rm [-r] <path…> — opens the delete modal, which asks you to type the name",
  hostname: "hostname — the host this pane is bound to",
  whoami: "whoami — the account the connection uses on that host",
  ssh: "ssh <host> — rebind the active pane to another host, by slug or address",
  clear: "clear — empty the output",
  help: "help [command] — this, or one line about one command",
};

// ------------------------------------------------------------- what it prints

/**
 * One line of scrollback, by what it *is* rather than by what colour it takes.
 *
 * A kind rather than a class name, because the panel decides how a kind is
 * drawn and this file is read by `pnpm verify:terminal` through Node, which has
 * no opinion about colour. `echo` is the line the person typed, kept above its
 * own output the way a terminal keeps it — scrollback that has lost the
 * question is a list of answers.
 *
 * Seven of them because the mockup draws seven, and the distinctions it makes
 * are ones worth having: an echo recedes so the answer stands out, a table sits
 * one shade below a scalar so a `df` reads as a block, and a state change —
 * "the pane is now on stg-01" — is green because it is a thing that happened
 * rather than a thing that was reported.
 */
export type LineKind = "echo" | "output" | "table" | "done" | "error" | "hint" | "quiet";

export interface TerminalLine {
  key: number;
  kind: LineKind;
  text: string;
}

/**
 * How much scrollback is kept, and how many typed lines the history holds.
 *
 * The ticket asks for "a few hundred lines". Five hundred is two screenfuls
 * either side of anything anyone is looking for, and a `ls` of a large
 * directory prints its cap and says so rather than filling the buffer with one
 * command's output and evicting everything that explains it.
 */
export const OUTPUT_LIMIT = 500;
export const HISTORY_LIMIT = 100;

/**
 * The most rows one `ls` will print.
 *
 * Lower than the buffer on purpose: `node_modules` is ten thousand entries, and
 * a terminal that answers `ls` by discarding everything else you have done is
 * not answering it. The pane is the right tool for a directory that size, and
 * the truncation line says so.
 */
export const LISTING_LIMIT = 200;

// ---------------------------------------------------------------- the columns

/** Which way a column's cells are padded. */
export type Align = "left" | "right";

/**
 * Rows of cells, padded into columns.
 *
 * Here, pure, rather than in the panel, because a column that is one space out
 * is invisible in a screenshot and obvious in a test. The last column is never
 * padded — trailing spaces on a file name are indistinguishable from a file
 * name with trailing spaces, which is a thing a filesystem allows.
 *
 * Widths come from the widest cell rather than from a constant: `ls -l` in a
 * directory of short names should not be indented past the middle of the panel
 * because some other directory has a long one.
 */
export function columns(rows: readonly (readonly string[])[], align: readonly Align[]): string[] {
  if (rows.length === 0) return [];

  const count = Math.max(...rows.map((row) => row.length));
  const widths: number[] = [];
  for (let index = 0; index < count; index += 1) {
    widths.push(Math.max(...rows.map((row) => (row[index] ?? "").length)));
  }

  return rows.map((row) =>
    row
      .map((cell, index) => {
        if (index === row.length - 1) return cell;
        return align[index] === "right" ? cell.padStart(widths[index]) : cell.padEnd(widths[index]);
      })
      .join("  "),
  );
}

// ----------------------------------------------------------------- the modals

export type Grouped = { ok: true; directory: string; names: string[] } | { ok: false; error: string; hint?: string };

/**
 * Absolute paths, as the one directory and the list of names a modal takes.
 *
 * `PermissionsTarget` and `DeleteTargetSelection` each carry a single
 * `directory` and rebuild every path from it with `joinPath`, which is the
 * right shape for a selection — a selection is always inside one listing — and
 * the wrong shape for a line of typed paths, which need not be. Rather than
 * reshape three shipped modals for this one caller, the terminal is held to
 * what they can express and says so when a line asks for more.
 *
 * The refusal is a real one and not a workaround dressed up: `chmod 644
 * /etc/hosts /var/log/syslog` opened as two stacked dialogues would have two
 * `Overlay`s listening for `⎋` on the same window, and the second confirmation
 * would appear over the first with no way to tell which one it was about.
 */
export function groupTargets(targets: readonly string[]): Grouped {
  if (targets.length === 0) return { ok: false, error: "nothing to act on" };

  const directories = new Set<string>();
  const names: string[] = [];

  for (const target of targets) {
    const segments = target.split("/").filter(Boolean);
    const name = segments.pop();
    if (name === undefined) {
      return { ok: false, error: "/ is not something this can act on" };
    }
    directories.add(`/${segments.join("/")}`);
    names.push(name);
  }

  if (directories.size > 1) {
    return {
      ok: false,
      error: "every path has to be in the same directory",
      hint: "The dialogue this opens takes one directory and a list of names. Run it once per directory.",
    };
  }

  return { ok: true, directory: [...directories][0], names };
}

// -------------------------------------------------------------------- `help`

/** What `help` prints, with no topic and with one. */
export function helpLines(topic: CommandName | null): string[] {
  if (topic !== null) return [USAGE[topic]];

  return [
    "A restricted set, not a shell. Each line is parsed into one intent and run",
    "through the same guards the buttons use — there is no passthrough.",
    "",
    ...columns(
      COMMANDS.map((name) => [name, USAGE[name].split(" — ")[1] ?? ""]),
      ["left", "left"],
    ),
  ];
}

// ------------------------------------------------------------------ the panel

/**
 * The surfaces and inks the terminal is drawn in.
 *
 * Here rather than in the component for the reason `sudo.ts` and `tail.ts` both
 * give: `scripts/verify-contrast.ts` measures these, and Node runs that script
 * directly — it can strip types, but not JSX. A check with its own copy of the
 * palette is a check of the copy.
 *
 * The ground is `chrome`, the darkest surface in the app and the one a command
 * preview already sits on (`COMMAND_SURFACE` in `sudo.ts`). That is not a
 * coincidence worth breaking: the modals render the operation they are about to
 * perform as a shell line on exactly this ground, and a terminal that used a
 * different one would be saying the same kind of thing in a different voice.
 *
 * The prompt's own two inks are not here — they are `PROMPT_INK` and
 * `PROMPT_ELEVATED_INK` in `sudo.ts`, unchanged and reused, because "`$` in link
 * blue, `#` in amber while a window is open" is one rule and it already has a
 * home (TRE-29).
 */
export const TERMINAL_SURFACE = "bg-terminal";
/** The header, which the mockup puts back on `chrome` — a lid, not a bar. */
export const TERMINAL_BAR = "bg-chrome";
/**
 * What the person typed, and it is dimmer than the answer, not brighter.
 *
 * The mockup's judgement and a good one: scrollback is read for what came back,
 * and an echo set brighter than its own output turns a column of answers into a
 * column of questions.
 */
export const TERMINAL_ECHO_INK = "text-ink-dim";
/** A scalar answer — `pwd`, `whoami`, a listing. */
export const TERMINAL_OUTPUT_INK = "text-ink";
/** Columns: `df`, and a `du` level. One shade down, so a block reads as one. */
export const TERMINAL_TABLE_INK = "text-ink-soft";
/** Something changed — the pane moved, the host was rebound. */
export const TERMINAL_DONE_INK = "text-success";
/** A refusal — the parser's, or the API's. */
export const TERMINAL_ERROR_INK = "text-danger-soft";
/** The second line under a refusal, which says what to do instead. */
export const TERMINAL_HINT_INK = "text-ink-muted";
/** The opening line, which is there to be found rather than read. */
export const TERMINAL_QUIET_INK = "text-on-terminal-dim";
/** The header row: the word TERMINAL in brand, everything else a step down. */
export const TERMINAL_TITLE_INK = "text-brand";
export const TERMINAL_LABEL_INK = "text-ink-dim";

/**
 * The prompt, in the mockup's three parts.
 *
 * Deliberately *not* `PROMPT_INK` from `sudo.ts`, and the difference is the
 * mockup's own. A modal's command preview is `$ chmod …` with no identity in
 * it, so its `$` carries the accent ink. Here the identity is present and takes
 * that ink itself — `user@host` — leaving the `$` a step quieter. Same rule
 * about what the character *means*, drawn for a line that has more in it.
 *
 * The elevated `#` is `text-warning`, which is `PROMPT_ELEVATED_INK` exactly.
 * That one is the signal, and a signal that changed colour between two places
 * in the same app would not be one.
 */
export const PROMPT_WHO_INK = "text-ink-label";
export const PROMPT_WHERE_INK = "text-on-terminal-dim";
export const PROMPT_CHAR_INK = "text-ink-dim";

/** Which ink a line of scrollback takes. */
export const LINE_INK: Readonly<Record<LineKind, string>> = {
  echo: TERMINAL_ECHO_INK,
  output: TERMINAL_OUTPUT_INK,
  table: TERMINAL_TABLE_INK,
  done: TERMINAL_DONE_INK,
  error: TERMINAL_ERROR_INK,
  hint: TERMINAL_HINT_INK,
  quiet: TERMINAL_QUIET_INK,
};
