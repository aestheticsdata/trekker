import { IsString, Matches, MinLength } from "class-validator";

/**
 * `GET /api/hash?hostId=…&path=…` (TRE-27 §2).
 *
 * One path, not a set. The inspector describes one entry at a time, and a
 * batched read is a shape TRE-28 can add when the comparison needs it — adding
 * it now would be a second code path with one caller and no test of the case
 * it exists for.
 */
export class HashQueryDto {
  @IsString()
  @MinLength(1, { message: "hostId is required" })
  hostId!: string;

  @IsString()
  @Matches(/^\//, { message: "path must be absolute" })
  path!: string;
}
