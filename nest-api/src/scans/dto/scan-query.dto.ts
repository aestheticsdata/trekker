import { IsOptional, IsString, MaxLength } from "class-validator";

export class ScanQueryDto {
  /** Which root's scan to serve. */
  @IsString()
  @MaxLength(700)
  root!: string;

  /**
   * Which level of the stored tree to return. Absent means the root's own
   * level, which is what the panel opens on.
   */
  @IsOptional()
  @IsString()
  @MaxLength(700)
  at?: string;
}
