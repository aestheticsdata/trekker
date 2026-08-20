import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from "class-validator";
import { MAX_DEPTH } from "@compare/compare-limits";

/**
 * `POST /api/compare` (TRE-28 §2).
 *
 * A POST rather than a GET, and not because it changes anything — it changes
 * nothing at all. It carries two host-and-path pairs, and two absolute paths in
 * a query string is a URL that any proxy in the way is entitled to log, cache
 * and truncate. The body is where a pair of filesystem paths belongs.
 *
 * Paths are only shape-checked here. Deciding whether one is *allowed* is
 * `PathGuardService`'s job, on its own host, after resolution (TRE-11).
 */
export class ComparePairDto {
  @IsString()
  @MinLength(1, { message: "hostId is required" })
  hostId!: string;

  @IsString()
  @MaxLength(700)
  @Matches(/^\//, { message: "path must be absolute" })
  path!: string;
}

export class CompareDto {
  /**
   * `ValidateNested` needs `@Type` beside it, and the omission is silent: the
   * nested object arrives as a plain object, no validator runs on it, and a
   * body with no `hostId` at all reaches the service. Same class of trap as the
   * `import type` one the controllers warn about.
   */
  @ValidateNested()
  @Type(() => ComparePairDto)
  a!: ComparePairDto;

  @ValidateNested()
  @Type(() => ComparePairDto)
  b!: ComparePairDto;

  /** Levels below the two roots to descend. See `compare-limits.ts`. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_DEPTH)
  depth?: number;
}
