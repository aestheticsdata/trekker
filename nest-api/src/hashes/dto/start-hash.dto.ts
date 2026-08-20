import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsString, Matches, MinLength } from "class-validator";
import { MAX_PATHS } from "@hashes/hash-limits";

/**
 * `POST /api/hash` (TRE-27 §2).
 *
 * The same shape as the delete and permission bodies, and deliberately: a
 * selection is a selection, and a route that spelled one differently would be
 * a route whose client code cannot be shared with theirs.
 *
 * Paths are only shape-checked here. Deciding whether one is *allowed* is
 * `PathGuardService`'s job, on the target host, after resolution (TRE-11) — a
 * validator that tried to judge safety by pattern would be the string
 * inspection that ticket exists to replace. `ArrayMaxSize` bounds the body;
 * what the *work* may cost is `MAX_FILES_PER_JOB` and `MAX_JOB_BYTES`, checked
 * after the directories in it have been expanded.
 */
export class StartHashDto {
  @IsString()
  @MinLength(1, { message: "hostId is required" })
  hostId!: string;

  @IsArray()
  @ArrayNotEmpty({ message: "Name at least one path." })
  @ArrayMaxSize(MAX_PATHS, { message: `At most ${MAX_PATHS} paths per request.` })
  @IsString({ each: true })
  @Matches(/^\//, { each: true, message: "Every path must be absolute." })
  paths!: string[];
}
