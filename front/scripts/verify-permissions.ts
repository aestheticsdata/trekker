/**
 * The permission grid, checked against the kernel (TRE-17).
 *
 * The ticket asks for the grid to be "verified against `stat` output for a
 * handful of modes including setuid and sticky", and there is no test runner in
 * `front/` yet — TRE-39 brings one. So this follows the convention nest-api
 * already uses for the things a unit test cannot reach: a script that does the
 * real thing and prints what it found.
 *
 * It creates a file and a directory at each mode, derives the octal string
 * exactly the way the API does, renders the grid from it, and compares the
 * result with the symbolic mode `stat` prints. Two independent readings of the
 * same inode, and they have to agree.
 *
 *   node scripts/verify-permissions.ts        (or: pnpm verify:permissions)
 *
 * Node runs the TypeScript directly, so this costs the package no dependency.
 *
 * NOTE for anyone extending it: BSD `stat -f %Lp` returns only the low nine
 * bits, so it cannot be the source of the octal here — it silently drops the
 * three bits this check exists for. The mode comes from `node:fs` instead,
 * masked the way `octalMode` masks it.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describeMode, permissionRows } from "../src/helpers/permissions.ts";

/** What the API sends as `mode` — see nest-api/src/fs/file-row.ts. */
function octalMode(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, "0");
}

/** The grid, flattened back into the nine characters `ls -l` would print. */
function gridAsLs(mode: string): string {
  const rows = permissionRows(mode);
  if (!rows) return "<unparseable>";
  const named = ["r", "w", "x"];
  return rows
    .flatMap(({ cells }) =>
      cells.map((cell, index) => {
        if (cell.glyph === "✓") return named[index];
        if (cell.glyph === "·") return "-";
        return cell.glyph; // s, S, t, T
      }),
    )
    .join("");
}

/** The symbolic mode, without the leading type character. */
function symbolicMode(target: string): string {
  const bsd = process.platform === "darwin" || process.platform.includes("bsd");
  const args = bsd ? ["-f", "%Sp", target] : ["-c", "%A", target];
  return execFileSync("stat", args, { encoding: "utf8" }).trim().slice(1);
}

const MODES = [
  "0000",
  "0400",
  "0640",
  "0644",
  "0755",
  "0777",
  "4755", // setuid, executable
  "4644", // setuid without execute -> S
  "2755", // setgid, executable
  "2644", // setgid without execute -> S
  "1777", // sticky, executable -> t
  "1666", // sticky without execute -> T
  "6755", // setuid + setgid
  "7777", // all three
];

const dir = mkdtempSync(join(tmpdir(), "tre17-"));
const made: string[] = [];
let failures = 0;
let checked = 0;

for (const mode of MODES) {
  for (const kind of ["file", "dir"] as const) {
    const target = join(dir, `${kind}-${mode}`);
    if (kind === "file") writeFileSync(target, "x");
    else mkdirSync(target);
    made.push(target);

    execFileSync("chmod", [mode, target]);

    const octal = octalMode(statSync(target).mode);
    const stored = symbolicMode(target);
    const rendered = gridAsLs(octal);
    checked += 1;

    if (rendered !== stored) {
      failures += 1;
      console.log(`FAIL ${kind.padEnd(4)} asked ${mode} -> node ${octal} | stat ${stored} | grid ${rendered}`);
    } else {
      console.log(`ok   ${kind.padEnd(4)} ${octal}  ${stored}${octal === mode ? "" : `  (kernel stored ${octal})`}`);
    }
  }
}

// A directory at 0000 cannot be traversed, so it has to be opened back up.
for (const target of made) chmodSync(target, 0o755);
rmSync(dir, { recursive: true, force: true });

console.log("\n--- describeMode, and what it refuses ---");
for (const mode of ["0640", "4755", "1777", "0000", "banana", "89", "12345"]) {
  console.log(`${mode.padEnd(8)} ${describeMode(mode)}`);
}

console.log(`\n${checked - failures}/${checked} modes matched stat.`);
process.exit(failures === 0 ? 0 : 1);
