import { Type } from "class-transformer";
import { IsInt, IsString, Matches, MaxLength, Min, MinLength } from "class-validator";
import { MAX_DIGEST_LENGTH } from "@fs/upload-resume";

/**
 * `GET /api/fs/upload/resume` (TRE-142).
 *
 * Asks how much of one file the host already holds, so the browser knows where
 * to slice its body. A read, so no `@Audited` and no CSRF — the audit rule is
 * that mutating verbs are recorded, and this changes nothing.
 *
 * `@Type(() => Number)` for the reason `TailQueryDto` gives at length: the
 * global pipe does no implicit conversion, so a query parameter arrives as a
 * string and `@IsInt` would refuse every value including the correct ones.
 */
export class UploadResumeQueryDto {
  @IsString()
  @MinLength(1, { message: "hostId is required" })
  hostId!: string;

  /** The directory the upload is going into. Judged by the guard, not here. */
  @IsString()
  @Matches(/^\//, { message: "path must be absolute" })
  path!: string;

  /**
   * The file's path relative to that directory — `a.jpg`, or `2019/a.jpg`.
   *
   * Bounded here only so a query cannot be a payload. What it is *allowed* to
   * be is `safeRelativePath`'s answer, and it is asked the same question here
   * as it is on the way in, so the two agree about which partial is which.
   */
  @IsString()
  @MinLength(1, { message: "name is required" })
  @MaxLength(4096)
  name!: string;

  @Type(() => Number)
  @IsInt({ message: "size must be a whole number of bytes." })
  @Min(0)
  size!: number;

  /** `File.lastModified`, in milliseconds. */
  @Type(() => Number)
  @IsInt({ message: "mtime must be a whole number of milliseconds." })
  @Min(0)
  mtime!: number;

  /**
   * Hex digest of the file's first megabyte.
   *
   * Constrained to hex because it is hashed into a filename on somebody's host.
   * The hashing already guarantees the result is hex whatever arrives, so this
   * is not what makes the name safe — it is what keeps a client that sends a
   * megabyte here from being hashed at all.
   */
  @IsString()
  @MaxLength(MAX_DIGEST_LENGTH)
  @Matches(/^[0-9a-f]+$/, { message: "digest must be lowercase hex." })
  digest!: string;
}
