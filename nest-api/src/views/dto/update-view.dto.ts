import { Type } from "class-transformer";
import { IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from "class-validator";
import { ViewLayoutDto } from "@views/dto/view-layout.dto";

/**
 * Rename, re-key, or overwrite with what is on screen (TRE-37 §4).
 *
 * Every field is optional and they are genuinely independent: "rename…" sends a
 * name, "update from current" sends a layout, the shortcut picker sends a slot.
 * A partial update rather than a whole row, because the alternative is the
 * rename dialogue also having to send a layout — which would silently make
 * every rename an "update from current" and quietly discard the difference the
 * dirty dot is there to show.
 *
 * `slot: null` clears the chord and is distinct from the field being absent.
 * That distinction is the whole of the shortcut picker's `none` button.
 */
export class UpdateViewDto {
  @IsOptional()
  @IsString()
  @MinLength(1, { message: "name must not be empty" })
  @MaxLength(64, { message: "name is at most 64 characters" })
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(9)
  slot?: number | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => ViewLayoutDto)
  layout?: ViewLayoutDto;

  @IsOptional()
  @IsObject()
  hostLabels?: Record<string, string>;
}
