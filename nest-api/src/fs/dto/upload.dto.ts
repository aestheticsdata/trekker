import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min, MinLength } from "class-validator";
import { MAX_DIGEST_LENGTH } from "@fs/upload-resume";

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

  /**
   * Continuing one file rather than starting it (TRE-142).
   *
   * All four together or none of them, and they describe **one** file — so the
   * route refuses a request that carries a second part while they are set. They
   * are in the query for the same reason the destination is: everything that
   * decides the fate of the body has to be readable before the body is.
   *
   * The token itself is never sent. The server computes it from these, so a
   * client cannot name which partial on the host it would like to append to.
   */
  @IsOptional()
  @IsString()
  @MaxLength(MAX_DIGEST_LENGTH)
  @Matches(/^[0-9a-f]+$/, { message: "resumeDigest must be lowercase hex." })
  resumeDigest?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  resumeSize?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  resumeMtime?: number;

  /** Where the client sliced. Zero is a restart that keeps the same name. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  resumeFrom?: number;
}
