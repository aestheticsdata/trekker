import { IsISO8601, IsOptional, IsString, Matches, MaxLength } from "class-validator";

/**
 * Filters for `GET /api/activity` (TRE-30 §4).
 *
 * Everything is a string. The global `ValidationPipe` runs with `whitelist`
 * but not `transform`, so query parameters arrive exactly as Express parsed
 * them and a `@Type(() => Number)` here would be decoration — `limit` is
 * shape-checked as digits and parsed where it is used. `FsQueryDto` takes the
 * same line.
 *
 * There is no `userId`. The session decides whose rows these are, and a filter
 * for it would be a parameter whose only purpose is to be ignored.
 */
export class ListActivityDto {
  @IsOptional()
  @IsString()
  @MaxLength(36)
  hostId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  kind?: string;

  @IsOptional()
  @IsISO8601({}, { message: "from must be an ISO-8601 timestamp" })
  from?: string;

  @IsOptional()
  @IsISO8601({}, { message: "to must be an ISO-8601 timestamp" })
  to?: string;

  /**
   * The id of the last row of the previous page. Opaque to the client on
   * purpose: it is a uuid v7, which is time-ordered, so paging is a plain
   * `id < cursor` and never drifts when new rows arrive mid-scroll. A
   * `createdAt` cursor would lose rows that share a millisecond, silently and
   * exactly at the page boundary.
   */
  @IsOptional()
  @IsString()
  @MaxLength(36)
  cursor?: string;

  @IsOptional()
  @Matches(/^\d{1,3}$/, { message: "limit must be a number" })
  limit?: string;
}
