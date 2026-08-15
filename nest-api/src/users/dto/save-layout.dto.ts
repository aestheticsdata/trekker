import { Type } from "class-transformer";
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, Matches, ValidateNested } from "class-validator";

/**
 * The last layout, on its way into `Users.lastLayout` (TRE-51).
 *
 * Validated rather than stored as whatever arrived, even though nothing queries
 * into the column and the front parses it again on the way out. Two reasons:
 * the column is a place an authenticated caller can write arbitrary JSON, so it
 * wants a ceiling and a shape; and the front's own URL parsers already reject
 * anything malformed, so a value this DTO would refuse is one the explorer
 * could never have produced.
 *
 * The field names are the URL's, not the database's. This is a footprint of the
 * query string and the two have to be read together — renaming here to look
 * tidier would mean a translation layer whose only job is to be wrong once.
 */

export const SPLIT_MODES = ["split", "left", "right"] as const;
export const VIEW_MODES = ["list", "detail"] as const;
export const SORT_KEYS = ["name", "size", "mode", "owner", "age"] as const;

/** Same ceiling as the URL parser, for the same reason: a path stays a path. */
const MAX_PATH = 700;
const MAX_GLOB = 200;

export class PaneLayoutDto {
  /**
   * Null is meaningful — "this pane is bound to nothing" — and is what a cold
   * open starts from, so it is optional rather than defaulted to a string.
   * Shape only: whether the host still exists is the explorer's to reconcile,
   * exactly as it already does for a host deleted while the app is open.
   */
  @IsOptional()
  @Matches(/^[0-9a-f-]{36}$/i, { message: "host must be a uuid" })
  host?: string | null;

  @IsString()
  @MaxLength(MAX_PATH)
  @Matches(/^\//, { message: "path must be absolute" })
  path!: string;

  @IsIn(SORT_KEYS)
  sort!: (typeof SORT_KEYS)[number];

  @IsIn([1, -1])
  dir!: 1 | -1;
}

export class SaveLayoutDto {
  @ValidateNested()
  @Type(() => PaneLayoutDto)
  a!: PaneLayoutDto;

  @ValidateNested()
  @Type(() => PaneLayoutDto)
  b!: PaneLayoutDto;

  @IsInt()
  @IsIn([0, 1])
  active!: 0 | 1;

  @IsIn(SPLIT_MODES)
  split!: (typeof SPLIT_MODES)[number];

  @IsIn(VIEW_MODES)
  view!: (typeof VIEW_MODES)[number];

  @IsBoolean()
  heat!: boolean;

  @IsBoolean()
  insp!: boolean;

  /** The disk-usage strip (TRE-33), open or collapsed. */
  @IsBoolean()
  du!: boolean;

  /**
   * The root that strip is pinned to, or null to follow the active pane.
   *
   * Nullable rather than optional: null is the value the explorer produces for
   * "nothing pinned", and accepting its absence as well would let two different
   * payloads mean the same thing — which is how a layout starts failing to
   * compare equal with itself and gets written back on every render.
   */
  @IsOptional()
  @IsString()
  @MaxLength(MAX_PATH)
  @Matches(/^\//, { message: "duRoot must be absolute" })
  duRoot?: string | null;

  @IsString()
  @MaxLength(MAX_GLOB)
  glob!: string;
}
