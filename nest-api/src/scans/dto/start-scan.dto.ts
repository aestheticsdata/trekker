import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { MAX_DEPTH } from "@scans/scan-limits";

export class StartScanDto {
  /**
   * The directory to walk. Validated by PathGuardService like every other path
   * in the application — the length cap here only matches the column, and is
   * not a security check.
   */
  @IsString()
  @MaxLength(700)
  root!: string;

  /**
   * How many levels of tree to keep. Not how deep to walk: `du` walks the whole
   * subtree whatever this says, because that is the only way it can produce a
   * subtotal at all (TRE-32 §1).
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_DEPTH)
  depth?: number;
}
