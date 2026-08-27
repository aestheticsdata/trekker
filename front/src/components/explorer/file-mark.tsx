"use client";

import { markShape, typeLetters } from "@helpers/listing";

import type { MarkInk } from "@helpers/listing";
import type { RowType } from "@lib/api/fs";

/**
 * The one thing in this application that draws a file or a folder (TRE-108).
 *
 * Three surfaces render an entry — a pane row, the copy plan, the delete
 * confirmation — and until this ticket they rendered three different objects: a
 * filled pastille in the pane, and the driver's own word for the kind in each
 * modal. One definition, two grounds, so a folder is the same shape wherever it
 * is shown and there is one place to change what that shape is.
 *
 * The geometry is the design's, and every step of it lands on Tailwind's 4px
 * scale, so nothing here is an arbitrary length and all of it follows
 * `--ui-base` (TRE-44). The two radii stay in `px` for the same reason they do
 * everywhere else: a 1px corner is a corner at any scale, and a scaled one is a
 * smudge.
 */
export function FileMark({
  type,
  extension,
  ink,
}: {
  type: RowType;
  /** Lowercased and without its dot. Ignored by a folder, which carries no letters. */
  extension: string;
  /** Which ground this is drawn on — `MARK_ON_PANE` or `MARK_ON_PANEL`. */
  ink: MarkInk;
}) {
  const shape = markShape(type);

  if (shape === "file") {
    // The letters are the accessible name and need no other one: "LOG" is what
    // the badge says and what it should read as.
    return (
      <span
        className={`flex h-3.25 w-3.5 flex-none items-center justify-center rounded-[1.5px] border font-mono text-tag leading-none font-bold tracking-normal ${ink.edge} ${ink.letters}`}
      >
        {typeLetters(extension)}
      </span>
    );
  }

  const fill = shape === "folder" ? ink.folder : ink.link;

  return (
    // 13 × 13, with the 6 × 3 tab at the top and the 13 × 10 body below it —
    // the design's `top: -3px` written as a box rather than as an overflow, so
    // the mark's own centre is what the row centres and no row grows by 3px.
    //
    // Labelled rather than hidden: dropping the letters took the string "DIR"
    // out of the DOM, and this column is the only place the listing says what
    // kind of thing a row is.
    <span
      role="img"
      aria-label={shape === "folder" ? "directory" : "symlink"}
      className="relative block h-3.25 w-3.25 flex-none"
    >
      <span className={`absolute top-0 left-0 h-0.75 w-1.5 rounded-t-[1px] ${fill}`} />
      <span className={`absolute bottom-0 left-0 h-2.5 w-3.25 rounded-[1px] ${fill}`} />
    </span>
  );
}
