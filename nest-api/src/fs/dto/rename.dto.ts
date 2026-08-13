import { IsString, Matches, MaxLength, MinLength } from "class-validator";
import { MAX_NAME_BYTES } from "@fs/rename-plan";

/**
 * `POST /api/fs/rename` (TRE-22 §1) — one entry, one new name.
 *
 * The new name is length-checked here and *meaning*-checked in the service,
 * through the same `nameProblem` the batch uses. Splitting it that way is
 * deliberate: a DTO can say "this is a string of plausible length", but "this
 * is one path segment and not a way out of the directory" is a rule the preview
 * has to be able to render rather than throw, so it lives with the plan.
 */
export class RenameDto {
  @IsString()
  hostId!: string;

  @IsString()
  @Matches(/^\//, { message: "The path must be absolute." })
  path!: string;

  @IsString()
  @MinLength(1, { message: "Give the new name." })
  // Characters here, bytes in the service: a DTO cannot know the encoding the
  // filesystem counts in, and this bound only exists to keep an absurd input
  // out of the code that does.
  @MaxLength(MAX_NAME_BYTES, { message: `A filename holds at most ${MAX_NAME_BYTES} bytes.` })
  newName!: string;
}
