import { Type } from "class-transformer";
import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength, ValidateNested } from "class-validator";
import { SORT_KEYS, SPLIT_MODES } from "@users/dto/save-layout.dto";

/**
 * What a saved view remembers (TRE-37 §1).
 *
 * A strict subset of `SaveLayoutDto`, and the subset is the design. A view is
 * two directories and how they are arranged; it is deliberately not where the
 * keyboard was (`active`), which file a pane was tailing (`tail`), or whether
 * the disk-usage strip was open (`du`, `duRoot`). Those change while somebody
 * is simply reading, and the dirty dot compares exactly these fields — a dot
 * that appears because the cursor moved to the other pane is the noise the
 * ticket asks this to avoid.
 *
 * The vocabulary is the URL's, imported rather than restated. `SPLIT_MODES` is
 * one three-valued thing here: `left` and `right` are what the mockup called
 * `solo`, and a second boolean saying the same thing is a second place for the
 * two to disagree.
 */

const MAX_PATH = 700;
const MAX_GLOB = 200;
/** All five column names and their commas, and no longer. */
const MAX_HIDE = 64;

export class ViewPaneDto {
  /**
   * Null is meaningful — a view may deliberately save a pane bound to nothing —
   * and shape is all this can check. Whether the host still exists is answered
   * on restore, where there is a person to tell (TRE-37 §2).
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

  /**
   * The columns this pane has turned off (TRE-124), by name and comma-separated.
   *
   * Shape only, like `glob`: which names are real is the front's vocabulary and
   * this class would be a second copy of it, going stale on the day a column is
   * added. The front drops what it cannot recognise on the way back out, which
   * fails in the safe direction — a column showing that should not be, never a
   * column nobody can find.
   *
   * Listed at all because the pipe is `whitelist: true`: a property this class
   * does not declare is stripped rather than refused, and the front's schema for
   * reading the column back is strict. A field dropped here would fail to parse
   * there, and every session restore in the app would quietly become a cold
   * open.
   */
  @IsOptional()
  @IsString()
  @MaxLength(MAX_HIDE)
  @Matches(/^[a-z,]*$/, { message: "hide must be comma-separated column names" })
  hide?: string;
}

export class ViewLayoutDto {
  @ValidateNested()
  @Type(() => ViewPaneDto)
  a!: ViewPaneDto;

  @ValidateNested()
  @Type(() => ViewPaneDto)
  b!: ViewPaneDto;

  @IsIn(SPLIT_MODES)
  split!: (typeof SPLIT_MODES)[number];

  @IsBoolean()
  insp!: boolean;

  @IsBoolean()
  heat!: boolean;

  @IsString()
  @MaxLength(MAX_GLOB)
  glob!: string;
}
