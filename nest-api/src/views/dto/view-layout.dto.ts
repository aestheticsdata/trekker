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
