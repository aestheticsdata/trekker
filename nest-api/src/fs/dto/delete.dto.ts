import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsString, Matches, MaxLength } from "class-validator";
import { MAX_PATHS } from "@fs/permissions.service";

/**
 * `POST /api/fs/delete/plan` and `/delete` (TRE-25 §1).
 *
 * One body for both, minus the token: the plan is the question and the delete
 * is the answer, and they have to be asked about exactly the same selection or
 * the confirmation means nothing.
 */

/** Longer than any single-segment filename, and shorter than an attack. */
export const MAX_TOKEN_LENGTH = 512;

export class DeletePlanDto {
  @IsString()
  hostId!: string;

  @IsArray()
  @ArrayNotEmpty({ message: "Name at least one path." })
  @ArrayMaxSize(MAX_PATHS, { message: `At most ${MAX_PATHS} paths per request.` })
  @IsString({ each: true })
  @Matches(/^\//, { each: true, message: "Every path must be absolute." })
  paths!: string[];
}

export class DeleteDto extends DeletePlanDto {
  /**
   * What the operator typed. Never trusted as a decision — the server derives
   * what it should have been from `paths` and compares — so this field is only
   * ever an input to that comparison.
   */
  @IsString()
  @MaxLength(MAX_TOKEN_LENGTH, { message: `A confirmation holds at most ${MAX_TOKEN_LENGTH} characters.` })
  confirmation!: string;
}
