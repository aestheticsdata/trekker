import { Type } from "class-transformer";
import { IsInt, IsOptional, Max, Min } from "class-validator";
import { FsQueryDto } from "@fs/dto/fs-query.dto";
import { TAIL_INITIAL_LINES_MAX } from "@fs/tail-limits";

/**
 * `GET /api/fs/tail` (TRE-34 §1).
 *
 * `hostId` and the shape-only check on `path` come from `FsQueryDto`; deciding
 * whether the path is *allowed* is still the guard's job on the target host,
 * after resolution.
 *
 * `@Type(() => Number)` is not decoration. The global pipe is
 * `ValidationPipe({ whitelist: true })` with no `transform` and no
 * `enableImplicitConversion`, so a query parameter arrives as a string and
 * `@IsInt` would refuse every value including the correct ones.
 *
 * No default here — `TailService` applies it. A default in the DTO would be a
 * second place for the number to live, and the limits table is the first.
 */
export class TailQueryDto extends FsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "lines must be a whole number." })
  @Min(0, { message: "lines must not be negative." })
  @Max(TAIL_INITIAL_LINES_MAX, { message: `lines must be at most ${TAIL_INITIAL_LINES_MAX}.` })
  lines?: number;
}
