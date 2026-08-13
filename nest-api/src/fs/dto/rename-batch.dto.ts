import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from "class-validator";
import { MAX_PATHS } from "@fs/permissions.service";

/**
 * `POST /api/fs/rename/preview` and `/rename/batch` (TRE-22 §1) — one body for
 * both, because they are one computation and the preview is the rendering of it.
 *
 * The pattern is bounded but not inspected. Deciding whether a regex is
 * *dangerous* by looking at it is a losing game — the safe version of that
 * check is the deadline the service runs it under, which does not care how the
 * pattern is written. The bound here is only so a megabyte of pattern never
 * reaches the compiler at all.
 */

/** Long enough for any rename a person writes; short enough to compile instantly. */
export const MAX_PATTERN_LENGTH = 512;

export class RenameBatchDto {
  @IsString()
  hostId!: string;

  @IsArray()
  @ArrayNotEmpty({ message: "Name at least one path." })
  @ArrayMaxSize(MAX_PATHS, { message: `At most ${MAX_PATHS} paths per request.` })
  @IsString({ each: true })
  @Matches(/^\//, { each: true, message: "Every path must be absolute." })
  paths!: string[];

  @IsString()
  @MaxLength(MAX_PATTERN_LENGTH, { message: `A pattern holds at most ${MAX_PATTERN_LENGTH} characters.` })
  pattern!: string;

  /** May be empty — deleting the matched span is a rename people actually want. */
  @IsString()
  @MaxLength(MAX_PATTERN_LENGTH, { message: `A replacement holds at most ${MAX_PATTERN_LENGTH} characters.` })
  replacement!: string;

  /** The `g` toggle: replace every occurrence rather than the first. */
  @IsOptional()
  @IsBoolean()
  global?: boolean;

  /** The `i` toggle. */
  @IsOptional()
  @IsBoolean()
  ignoreCase?: boolean;
}
