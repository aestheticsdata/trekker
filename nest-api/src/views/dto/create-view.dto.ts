import { Type } from "class-transformer";
import { IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from "class-validator";
import { ViewLayoutDto } from "@views/dto/view-layout.dto";

/**
 * A named layout, on its way into `Views` (TRE-37 §1).
 *
 * `slot` is the digit, not `"⌥3"`. How a chord reads belongs to the front's one
 * keymap (TRE-36 §2), and a glyph in a column is a second place it is written —
 * which is the thing that file exists to prevent. 1–9 because that is what the
 * chord table offers, and the ceiling is enforced here rather than trusted: it
 * is a number an authenticated caller supplies.
 */
export class CreateViewDto {
  @IsString()
  @MinLength(1, { message: "name must not be empty" })
  @MaxLength(64, { message: "name is at most 64 characters" })
  name!: string;

  /** Null clears it, absent leaves it unset — the same on create, both meaning "no chord". */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(9)
  slot?: number | null;

  @ValidateNested()
  @Type(() => ViewLayoutDto)
  layout!: ViewLayoutDto;

  /**
   * Host id to the label that host had when this was saved, for the one
   * sentence a broken view has to be able to say.
   *
   * Not validated past "an object": it is a memo the front writes and the front
   * reads, it is never compared and never queried into, and the two ids it can
   * usefully hold are already in `layout`. The service caps its size, which is
   * the only thing about it that could hurt anybody.
   */
  @IsOptional()
  @IsObject()
  hostLabels?: Record<string, string>;
}
