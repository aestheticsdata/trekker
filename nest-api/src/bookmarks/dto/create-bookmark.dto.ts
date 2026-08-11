import { IsInt, IsOptional, IsString, Matches, MaxLength, Min, MinLength } from "class-validator";

/**
 * A favourite: one directory on one host, with the label the sidebar draws
 * (TRE-18 §3).
 *
 * `hostId` is required and is the ownership anchor — a bookmark has no `userId`
 * of its own, so the service reaches the owner through the host and a foreign
 * `hostId` reads as 404, the same convention HostsService uses.
 */
export class CreateBookmarkDto {
  @IsString()
  @Matches(/^[0-9a-f-]{36}$/i, { message: "hostId must be an id" })
  hostId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(700, { message: "path is at most 700 characters" })
  @Matches(/^\//, { message: "path must be absolute" })
  path!: string;

  @IsString()
  @MinLength(1, { message: "label must not be empty" })
  @MaxLength(64, { message: "label is at most 64 characters" })
  label!: string;

  /** The small grey second line — an item count, a size, whatever is useful. */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  hint?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
}
