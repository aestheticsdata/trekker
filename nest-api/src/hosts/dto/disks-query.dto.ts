import { IsOptional, Matches } from "class-validator";

/**
 * The one option `GET /api/hosts/:id/disks` takes (TRE-31).
 *
 * A string, like every other query parameter in this API: the global
 * `ValidationPipe` runs with `whitelist` but not `transform`, so `?pseudo=true`
 * arrives as the four characters Express parsed and is read where it is used.
 * `ListActivityDto` takes the same line and says why at greater length.
 *
 * There is no host id here — that is the path parameter, and the session
 * decides whether it is yours.
 */
export class DisksQueryDto {
  /** Show `tmpfs` and the other pseudo-filesystems too. Off unless asked. */
  @IsOptional()
  @Matches(/^(true|false|1|0)$/, { message: "pseudo must be true or false" })
  pseudo?: string;
}
