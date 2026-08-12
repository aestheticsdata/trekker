import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsBoolean, IsOptional, IsString, Matches } from "class-validator";
import { MAX_PATHS } from "@fs/permissions.service";

/**
 * `POST /api/fs/chmod` (TRE-21 §1).
 *
 * The mode is a string of octal digits and stays one until the service parses
 * it: a number in JSON invites `0644` being read as decimal 644, which is a
 * different and perfectly valid mode. Shape only here — what the bits *mean*,
 * and whether they leave setuid behind, is decided where the change is made.
 *
 * Paths are shape-checked and nothing more. Judging whether one is allowed is
 * the guard's job, on the target host, after resolution (TRE-11).
 */
export class ChangeModeDto {
  @IsString()
  hostId!: string;

  @IsArray()
  @ArrayNotEmpty({ message: "Name at least one path." })
  @ArrayMaxSize(MAX_PATHS, { message: `At most ${MAX_PATHS} paths per request.` })
  @IsString({ each: true })
  @Matches(/^\//, { each: true, message: "Every path must be absolute." })
  paths!: string[];

  @IsString()
  @Matches(/^[0-7]{3,4}$/, { message: "Mode must be three or four octal digits, such as 0644." })
  mode!: string;

  @IsOptional()
  @IsBoolean()
  recursive?: boolean;
}
