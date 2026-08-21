/**
 * The terminal's parser, and every shape that must never become two commands
 * (TRE-35).
 *
 * This is the ticket's own Done item — "a test file of injection attempts" —
 * and it is the check this feature lives or dies by. The parser is the entire
 * security boundary: past it there is no string left to escape, only a typed
 * intent whose fields go into API calls the buttons were already making. So
 * what has to be proven here is that nothing gets past it in a shape the
 * runner would read as a second instruction.
 *
 *   node scripts/verify-terminal.ts        (or: pnpm verify:terminal)
 *
 * Node runs the TypeScript directly, so this costs the package no dependency.
 * There is no test runner in `front/` yet; until there is, this follows the
 * convention the other seven scripts here already use.
 */

import {
  COMMANDS as COMMAND_NAMES,
  columns,
  groupTargets,
  helpLines,
  parse,
  resolve,
} from "../src/helpers/terminal.ts";

import type { TerminalContext } from "../src/helpers/terminal.ts";

const HERE: TerminalContext = { cwd: "/srv/app", home: "/home/example-user" };

let checks = 0;
let failures = 0;

function check(what: string, ok: boolean, detail = ""): void {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.log(`  FAIL ${what}${detail ? ` — ${detail}` : ""}`);
}

/** The parse, or null when it was refused. */
function intentOf(line: string) {
  const parsed = parse(line, HERE);
  return parsed !== null && parsed.ok ? parsed.intent : null;
}

function refused(line: string): boolean {
  const parsed = parse(line, HERE);
  return parsed !== null && !parsed.ok;
}

/* ---- the injection table ------------------------------------------------- */

console.log("--- lines that must never become a second command ---");

/**
 * Every one of these is refused outright rather than parsed into a harmless
 * first command. Both outcomes are safe — the return type has room for one
 * intent and no more — but a line that quietly listed a file called `;` would
 * leave the reader believing a chain had run.
 */
const INJECTIONS: readonly string[] = [
  "ls; rm -rf /",
  "ls && rm -rf /",
  "ls || rm -rf /",
  "ls | grep secret",
  "ls > /etc/passwd",
  "ls >> /etc/passwd",
  "cat < /etc/shadow",
  "ls `rm -rf /`",
  "ls $(rm -rf /)",
  "ls ${HOME}",
  "ls $HOME",
  "ls &",
  "cd /tmp; cd /",
  "rm -rf / ; echo done",
  "ls\nrm -rf /",
  "ls\r\nwhoami",
  "help; help",
  "ssh a$(id)b",
  "chmod 777 /etc & rm -rf /",
  // The classic argument-injection shape: a value that looks like a flag.
  "du `whoami`",
];

for (const line of INJECTIONS) {
  check(`refuses ${JSON.stringify(line)}`, refused(line));
}

/* ---- quoting, which is how a real filename with a metacharacter is reached */

console.log("--- quoting: literal, and never expanding ---");

check("a quoted semicolon is part of a name", intentOf("ls 'a;b'")?.kind === "ls");
check(
  "and it lands in the path",
  (intentOf("ls 'a;b'") as { path?: string } | null)?.path === "/srv/app/a;b",
  String((intentOf("ls 'a;b'") as { path?: string } | null)?.path),
);
check(
  "a quoted space is one word",
  (intentOf('ls "my files"') as { path?: string } | null)?.path === "/srv/app/my files",
);
// Nothing expands, ever — neither quote style, which is the one place this
// deliberately differs from a shell.
check(
  "a dollar in quotes stays five characters",
  (intentOf('ls "$HOME"') as { path?: string } | null)?.path === "/srv/app/$HOME",
  String((intentOf('ls "$HOME"') as { path?: string } | null)?.path),
);
check("an unbalanced quote is refused", refused("ls 'unterminated"));
check(
  "a backslash is an ordinary character in a name",
  (intentOf("ls a\\b") as { path?: string } | null)?.path === "/srv/app/a\\b",
);

/* ---- the commands -------------------------------------------------------- */

console.log("--- what each command parses to ---");

check("an empty line is nothing at all", parse("   ", HERE) === null);
check("an unknown command is refused", refused("curl https://example.com"));
check("and so is one that only looks known", refused("lsof"));

check("ls with no argument means here", (intentOf("ls") as { path?: string } | null)?.path === "/srv/app");
check("ls -la is accepted and ignored", intentOf("ls -la")?.kind === "ls");
check("ls -z is not", refused("ls -z"));
check("ls takes one directory", refused("ls /a /b"));

check("bare cd goes home", (intentOf("cd") as { path?: string } | null)?.path === "/home/example-user");
check("cd - is the pane's back button", intentOf("cd -")?.kind === "cdBack");
check("cd .. climbs", (intentOf("cd ..") as { path?: string } | null)?.path === "/srv");

check("pwd takes nothing", refused("pwd /srv"));
check("df takes nothing", refused("df -h"));
check("hostname takes nothing", refused("hostname x"));
check("whoami takes nothing", refused("whoami root"));
check("clear takes nothing", refused("clear all"));

check("du defaults to here", (intentOf("du") as { path?: string } | null)?.path === "/srv/app");
check("du -sh is accepted", intentOf("du -sh /var")?.kind === "du");

check("chmod needs a mode and a target", refused("chmod 644"));
check("chmod takes octal", intentOf("chmod 0755 x")?.kind === "chmod");
check("chmod refuses symbolic modes", refused("chmod u+x x"));
check("chmod refuses a mode that is not octal", refused("chmod 888 x"));
check(
  "chmod resolves every target",
  JSON.stringify((intentOf("chmod 644 a b") as { targets?: string[] } | null)?.targets) ===
    JSON.stringify(["/srv/app/a", "/srv/app/b"]),
);

check("rm needs a target", refused("rm -rf"));
check("rm -rf is recursive", (intentOf("rm -rf old") as { recursive?: boolean } | null)?.recursive === true);
check("rm -R is too", (intentOf("rm -R old") as { recursive?: boolean } | null)?.recursive === true);
check("plain rm is not", (intentOf("rm old") as { recursive?: boolean } | null)?.recursive === false);
// `-f` says "do not ask" everywhere else. Here the asking is the feature, so it
// parses and changes nothing: the intent still opens the modal.
check("rm -f still opens the modal", intentOf("rm -f old")?.kind === "rm");

check("ssh takes one host", intentOf("ssh web-01")?.kind === "ssh");
check("ssh with no host is refused", refused("ssh"));
check("ssh with two is refused", refused("ssh a b"));

check("help with no topic", (intentOf("help") as { topic?: string | null } | null)?.topic === null);
check("help on a command", (intentOf("help rm") as { topic?: string } | null)?.topic === "rm");
check("help on a non-command is refused", refused("help sudo"));

/* ---- path resolution ----------------------------------------------------- */

console.log("--- paths, resolved to absolute before anything sees them ---");

const PATHS: ReadonlyArray<[string, string]> = [
  [".", "/srv/app"],
  ["..", "/srv"],
  ["../..", "/"],
  ["../../..", "/"],
  ["logs", "/srv/app/logs"],
  ["./logs", "/srv/app/logs"],
  ["logs/", "/srv/app/logs"],
  ["logs//nginx", "/srv/app/logs/nginx"],
  ["../other/thing", "/srv/other/thing"],
  ["/", "/"],
  ["/var/log", "/var/log"],
  ["/var/../etc", "/etc"],
  ["/..", "/"],
  ["a/../b", "/srv/app/b"],
];

for (const [argument, want] of PATHS) {
  const got = resolve(argument, HERE);
  check(`${argument.padEnd(16)} → ${want}`, got === want, got);
}

// Whatever this file produces is a well-formed absolute path and nothing more.
// Whether it is *allowed* is the API guard's answer, on the host, after
// realpath (TRE-11) — so a traversal that resolves cleanly here is still
// refused there, and that is the boundary that counts.
check("a traversal resolves rather than escaping", resolve("../../../../etc/shadow", HERE) === "/etc/shadow");

/* ---- the columns --------------------------------------------------------- */

console.log("--- columns, which are what makes a listing readable ---");

{
  const laid = columns(
    [
      ["-rw-r--r--", "root", "1.2 KB", "notes.txt"],
      ["drwxr-xr-x", "deploy", "4 KB", "releases"],
    ],
    ["left", "left", "right", "left"],
  );
  check("every row is one line", laid.length === 2);
  check("cells are padded to the widest", laid[0] === "-rw-r--r--  root    1.2 KB  notes.txt", JSON.stringify(laid[0]));
  check(
    "a right-aligned cell is padded in front",
    laid[1] === "drwxr-xr-x  deploy    4 KB  releases",
    JSON.stringify(laid[1]),
  );
  // A file name may legally end in a space, and a padded last column would be
  // indistinguishable from one that does.
  check("the last column is never padded", !laid[1].endsWith(" "));
}

check("no rows, no lines", columns([], ["left"]).length === 0);

/* ---- the one-directory rule ---------------------------------------------- */

console.log("--- grouping typed paths into what a modal can take ---");

{
  const grouped = groupTargets(["/srv/app/a", "/srv/app/b"]);
  check("same directory groups", grouped.ok === true);
  if (grouped.ok) {
    check("the directory is theirs", grouped.directory === "/srv/app", grouped.directory);
    check("and the names are basenames", JSON.stringify(grouped.names) === JSON.stringify(["a", "b"]));
  }
}

{
  const grouped = groupTargets(["/etc/hosts"]);
  check("a single path groups", grouped.ok === true);
  if (grouped.ok) check("with its own parent", grouped.directory === "/etc", grouped.directory);
}

{
  const grouped = groupTargets(["/srv/app/a", "/var/log/b"]);
  check("two directories are refused", grouped.ok === false);
  if (!grouped.ok) check("and the refusal says why", grouped.error.includes("same directory"), grouped.error);
}

{
  const top = groupTargets(["/a"]);
  check("a path at the root groups", top.ok === true);
  if (top.ok) check("with / as the directory", top.directory === "/", top.directory);
}

check("the root itself is refused", groupTargets(["/"]).ok === false);
check("nothing at all is refused", groupTargets([]).ok === false);

/* ---- help ---------------------------------------------------------------- */

console.log("--- help, which is the only answer to a refused command ---");

{
  const all = helpLines(null);
  check(
    "help names every command",
    COMMAND_NAMES.every((name) => all.some((line) => line.startsWith(name))),
  );
  check(
    "and only one line per command",
    COMMAND_NAMES.every((name) => all.filter((line) => line.startsWith(`${name} `) || line === name).length === 1),
  );
}

check("help on one command is one line", helpLines("rm").length === 1);
check("and it is that command's line", helpLines("rm")[0].startsWith("rm "), helpLines("rm")[0]);

console.log(`\n${checks - failures}/${checks} checks pass.`);
process.exit(failures === 0 ? 0 : 1);
