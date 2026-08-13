import { IsIn, IsOptional, IsString, Matches, MinLength } from "class-validator";

/**
 * Where an upload goes, and what to do if something is already there (TRE-65).
 *
 * A query DTO rather than multipart fields, and that is a security decision
 * rather than a convenience: query parameters are parsed before the body is
 * read, so the destination is validated against the roots while the file is
 * still on the wire. A field carrying the directory could legally arrive after
 * the file part, which would mean receiving bytes with nowhere yet decided to
 * put them.
 */
export class UploadQueryDto {
  @IsString()
  @MinLength(1, { message: "hostId is required" })
  hostId!: string;

  /** The directory to upload into. Judged by the guard, not by this pattern. */
  @IsString()
  @Matches(/^\//, { message: "path must be absolute" })
  path!: string;

  /**
   * The transfer modal's vocabulary, shared so the two operations answer the
   * same question the same way. Absent means `keepBoth`: the answer that
   * destroys nothing is the one to arrive at by default.
   */
  @IsOptional()
  @IsIn(["overwrite", "skip", "keepBoth"])
  conflict?: "overwrite" | "skip" | "keepBoth";
}
