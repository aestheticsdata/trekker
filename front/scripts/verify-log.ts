/**
 * The three rules the tail strip applies to strings (TRE-34 §3).
 *
 * Two of the ticket's Done items are about exactly this — "access-log lines
 * render with the status coloured; a malformed line renders verbatim" — and
 * neither can be settled by looking at a running app, because the way this
 * fails is on the one line in ten thousand that has a three-digit run
 * somewhere unexpected. A port. A byte count. A timestamp. Every one of those
 * paints a random number red in the middle of a log somebody is reading during
 * an incident, which is the worst possible moment to be lying to them.
 *
 *   node scripts/verify-log.ts        (or: pnpm verify:log)
 *
 * Node runs the TypeScript directly, so this costs the package no dependency.
 * There is no test runner in `front/` yet; TRE-39 brings one, and this moves
 * into it. Until then it follows the convention the other five scripts here
 * already use.
 *
 * The backend's `verify:tail` is the other half and answers a different
 * question — whether anything is left running on the host. Both names are the
 * same feature; neither script can answer the other's question.
 *
 * The sample lines use `192.0.2.10`, which is RFC 5737 documentation space and
 * routes nowhere. Not decoration: this repo is public and `.gitleaks.toml`
 * refuses any IPv4 that is not loopback, private or documentation. The obvious
 * made-up address to reach for here is a real routed one, and the sweep would
 * refuse it — correctly, since no rule can tell an invented address from
 * somebody's server.
 */
import { isLogDirectory, looksLikeLog, splitLine } from "../src/helpers/tail.ts";

let checks = 0;
let failures = 0;

function check(what: string, ok: boolean, detail = ""): void {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.log(`  FAIL ${what}${detail ? ` — ${detail}` : ""}`);
}

/* ---- the status code, and everything that is not one --------------------- */

console.log("--- an access-log line, coloured by class ---");

/** A line, the status it should find, and the class that status falls in. */
const COLOURED: ReadonlyArray<[string, string, "ok" | "client" | "server"]> = [
  ['192.0.2.10 - - [21/Aug/2026:10:00:00 +0000] "GET / HTTP/1.1" 200 1234', "200", "ok"],
  // 3xx shares the ink with 2xx: a redirect is a request that was served.
  ['192.0.2.10 - - [21/Aug/2026:10:00:00 +0000] "GET /old HTTP/1.1" 301 0', "301", "ok"],
  ['192.0.2.10 - - [21/Aug/2026:10:00:00 +0000] "GET /gone HTTP/1.1" 404 153', "404", "client"],
  ['192.0.2.10 - - [21/Aug/2026:10:00:00 +0000] "POST /api HTTP/1.1" 502 0', "502", "server"],
  // Combined: two more quoted fields after the status, which is where a greedy
  // match starts from and has to walk all the way back.
  [
    '192.0.2.10 - - [21/Aug/2026:10:00:00 +0000] "GET / HTTP/1.1" 503 615 "https://example/x" "Mozilla/5.0 (X11)"',
    "503",
    "server",
  ],
  // The size is also three digits, and it is not the status.
  ['192.0.2.10 - - [21/Aug/2026:10:00:00 +0000] "GET /a HTTP/1.1" 200 404', "200", "ok"],
  // A custom format that quotes the vhost before the request. The digits are
  // what disambiguate, which is why the anchor is "a quoted field followed by
  // three digits" rather than "the first quoted field".
  ['example.com "GET /a HTTP/1.1" 418 12', "418", "client"],
  // Nothing after the status at all.
  ['192.0.2.10 - - [d] "GET / HTTP/1.1" 200', "200", "ok"],
];

const CLASS_INK = { ok: "text-log-ok", client: "text-log-client", server: "text-log-server" };

for (const [line, status, kind] of COLOURED) {
  const split = splitLine(line);
  check(`finds ${status}`, split.status === status, `got ${split.status ?? "nothing"}`);
  check(`${status} is ${kind}`, split.ink === CLASS_INK[kind], `got ${split.ink ?? "nothing"}`);
  // The whole line has to survive being taken apart, or the strip is showing
  // the reader an edited version of their own log.
  check(`${status} loses nothing`, split.head + (split.status ?? "") + split.tail === line);
}

console.log("--- and every shape that must be left alone ---");

/** Lines with a three-digit run in them that is not a status. */
const VERBATIM: readonly string[] = [
  // An nginx error log. No quoted request, so nothing to anchor on.
  "2026/08/21 10:00:00 [error] 123#456: *789 connect() failed while connecting to upstream",
  // A port that is three digits, in a line with no request at all.
  "connection from 127.0.0.1:443 established after 250 ms",
  // A bare sentence with a number in it.
  "Started nginx.service - A high performance web server",
  "restarting worker 502 after 30s",
  // A structured log: quotes everywhere, no access-log shape.
  '{"level":"info","status":"ok","ms":250,"msg":"served"}',
  // The empty line a log file ends with.
  "",
  // A quoted field whose next token is three digits *of a word*.
  'said "hello" 404notfound',
];

for (const line of VERBATIM) {
  const split = splitLine(line);
  check(`verbatim: ${line.slice(0, 46) || "(empty)"}`, split.status === null, `coloured ${split.status ?? ""}`);
  check("verbatim keeps the line", split.head === line && split.tail === "");
}

/* ---- where the strip offers itself --------------------------------------- */

console.log("--- the log-directory heuristic ---");

for (const path of [
  "/var/log",
  "/var/log/nginx",
  "/var/logs",
  "/srv/app/logs",
  "/home/example-user/log",
  "/opt/x/log/old",
]) {
  check(`offers in ${path}`, isLogDirectory(path));
}

for (const path of [
  "/",
  "/etc",
  "/home/example-user",
  "/var",
  "/varlog",
  "/blog",
  "/home/example-user/blogs",
  "/usr/share/doc",
]) {
  check(`stays out of ${path}`, !isLogDirectory(path));
}

/* ---- and which files it offers there ------------------------------------- */

console.log("--- the picker's candidates ---");

for (const name of [
  "access.log",
  "error.log",
  "access.log.1",
  "nginx-error.log",
  "catalina.out",
  "app.err",
  "log",
  // The two that no pattern reaches and that every /var/log has.
  "syslog",
  "syslog.1",
  "messages",
  "dmesg",
]) {
  check(`offers ${name}`, looksLikeLog(name));
}

for (const name of [
  // Compressed: the framer would scrub it into nothing legible.
  "access.log.2.gz",
  "syslog.1.gz",
  // Words that merely contain "log".
  "logrotate.conf",
  "blog.txt",
  "dialogue.md",
  "README",
  "nginx.conf",
  // Binary account records, which live in /var/log and are not text.
  "wtmp",
  "btmp",
]) {
  check(`skips ${name}`, !looksLikeLog(name));
}

console.log(`\n${checks - failures}/${checks} checks pass.`);
process.exit(failures === 0 ? 0 : 1);
