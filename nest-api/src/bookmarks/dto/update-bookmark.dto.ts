import { IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from "class-validator";

/**
 * Rename, re-hint or reorder. Neither the host nor the path can change — a
 * bookmark that pointed somewhere else would be a different bookmark, and
 * `@@unique([hostId, path])` is what the client would have to reason about
 * instead of simply deleting and adding.
 */
export class UpdateBookmarkDto {
  @IsOptional()
  @IsString()
  @MinLength(1, { message: "label must not be empty" })
  @MaxLength(64)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  hint?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
}
