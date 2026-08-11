import { IsIn, IsString, Matches, MaxLength } from "class-validator";

/**
 * One allowed root (TRE-11). The security boundary, so it is a typed row on the
 * wire rather than a string a client splits on a colon — a root that arrives
 * malformed must be refused at the edge, not normalised into something wider
 * than it was meant to be.
 *
 * `WRITE` implies `READ`: the guard only rejects a non-WRITE root when the
 * intent is a write, so there is no third level and no ordering to get wrong.
 */
export const ROOT_ACCESS = ["READ", "WRITE"] as const;
export type RootAccessInput = (typeof ROOT_ACCESS)[number];

/** The column is VarChar(700); refusing longer here beats a truncated allowlist. */
export const MAX_ROOT_PATH = 700;

/**
 * A ceiling on how many roots one host may carry. Not a design limit — the
 * guard resolves every root on the host for each request (TRE-11), so a
 * thousand of them is a thousand round trips per listing.
 */
export const MAX_ROOTS = 32;

export class HostRootInput {
  @IsString()
  @MaxLength(MAX_ROOT_PATH, { message: `a root path is at most ${MAX_ROOT_PATH} characters` })
  @Matches(/^\//, { message: "a root path must be absolute" })
  path!: string;

  @IsIn(ROOT_ACCESS, { message: "root access must be READ or WRITE" })
  access!: RootAccessInput;
}
