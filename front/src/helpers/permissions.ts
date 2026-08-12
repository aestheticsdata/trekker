/**
 * A mode string, as a grid (TRE-17 §2).
 *
 * The server sends two renderings of the same bits: `mode`, four octal digits,
 * and `modeText`, the nine-character `ls` string. The grid is built from the
 * octal one because `modeText` cannot express the setuid, setgid and sticky
 * bits — it is nine characters for nine bits, and those three live in the
 * fourth digit. A grid drawn from it would show `0755` and `4755` identically,
 * which is precisely the pair someone opens this panel to tell apart.
 */

export type PermissionClass = "user" | "group" | "other";

export interface PermissionCell {
  /** What the cell prints: ✓, ·, or one of s/S/t/T when a special bit is set. */
  glyph: string;
  /** Whether the bit is granted — the filled tile in the mockup. */
  granted: boolean;
  /** Named only when there is something a glyph alone does not say. */
  note?: string;
}

export interface PermissionRow {
  who: PermissionClass;
  /** Read, write, execute, in that order. */
  cells: [PermissionCell, PermissionCell, PermissionCell];
}

/**
 * The fourth octal digit, and what it does to each class's execute column.
 *
 * Lowercase means the execute bit is set as well, uppercase means it is not —
 * `ls` has drawn it that way for decades, and the capital is the warning it is
 * meant to be: a setuid binary nobody can execute is almost always a mistake.
 */
const SPECIAL: Record<PermissionClass, { bit: number; on: string; off: string; name: string }> = {
  user: { bit: 0o4000, on: "s", off: "S", name: "setuid" },
  group: { bit: 0o2000, on: "s", off: "S", name: "setgid" },
  other: { bit: 0o1000, on: "t", off: "T", name: "sticky" },
};

const CLASSES: readonly PermissionClass[] = ["user", "group", "other"];

/**
 * Parse "0640", "4755", "1777". Returns null for anything else — a mode is
 * server data, and a panel that renders NaN as nine denied cells would be
 * claiming a fact it does not have.
 */
export function parseMode(mode: string): number | null {
  if (!/^[0-7]{3,4}$/.test(mode)) return null;
  return Number.parseInt(mode, 8);
}

export function permissionRows(mode: string): PermissionRow[] | null {
  const bits = parseMode(mode);
  if (bits === null) return null;

  return CLASSES.map((who, index) => {
    // user occupies bits 8-6, group 5-3, other 2-0.
    const triple = (bits >> (6 - index * 3)) & 0b111;
    const special = SPECIAL[who];
    const executable = (triple & 0b001) !== 0;
    const isSpecial = (bits & special.bit) !== 0;

    return {
      who,
      cells: [
        { glyph: triple & 0b100 ? "✓" : "·", granted: (triple & 0b100) !== 0 },
        { glyph: triple & 0b010 ? "✓" : "·", granted: (triple & 0b010) !== 0 },
        isSpecial
          ? {
              glyph: executable ? special.on : special.off,
              granted: executable,
              note: executable ? special.name : `${special.name}, without execute`,
            }
          : { glyph: executable ? "✓" : "·", granted: executable },
      ],
    };
  });
}

/**
 * The grid in a sentence, for anyone who is not looking at it.
 *
 * The grid itself is sixteen unlabelled cells; read out one by one they say
 * nothing, so it is presented as a single image with this as its label.
 */
export function describeMode(mode: string): string {
  const rows = permissionRows(mode);
  if (!rows) return `Permissions ${mode}`;

  const named = ["read", "write", "execute"];
  const parts = rows.map(({ who, cells }) => {
    const granted = cells.map((cell, index) => (cell.granted ? named[index] : null)).filter(Boolean);
    const notes = cells.map((cell) => cell.note).filter(Boolean);
    const list = granted.length > 0 ? granted.join(", ") : "nothing";
    return notes.length > 0 ? `${who} ${list} (${notes.join(", ")})` : `${who} ${list}`;
  });

  return `Permissions ${mode}: ${parts.join("; ")}`;
}
