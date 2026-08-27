import { Type } from "class-transformer";
import { IsInt, IsOptional, Max, Min } from "class-validator";
import { DEFAULT_MAX_ENTRIES } from "@fs/fs.service";
import { FsQueryDto } from "@fs/dto/fs-query.dto";

/**
 * `GET /api/fs/dir-sizes/stream` (TRE-107).
 *
 * `hostId` and the shape-only check on `path` come from `FsQueryDto`.
 *
 * The two numbers are a *hint about order*, and nothing else — which is why
 * they are optional and why nothing goes wrong when they are absent or absurd.
 * They say which rows the client currently has on screen so those directories
 * are walked first; every directory is walked either way. `visibleFirst` clamps
 * them, so a client asking for row nine million gets the listing in its own
 * order rather than an error.
 *
 * `@Type(() => Number)` for the reason `TailQueryDto` gives: the global pipe
 * does not convert, so a query parameter arrives as a string and `@IsInt` would
 * refuse every value including the right ones.
 */
export class DirSizesQueryDto extends FsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "firstVisible must be a whole number." })
  @Min(0, { message: "firstVisible must not be negative." })
  @Max(DEFAULT_MAX_ENTRIES, { message: "firstVisible is beyond any listing this API returns." })
  firstVisible?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "visibleCount must be a whole number." })
  @Min(0, { message: "visibleCount must not be negative." })
  @Max(DEFAULT_MAX_ENTRIES, { message: "visibleCount is beyond any listing this API returns." })
  visibleCount?: number;
}
