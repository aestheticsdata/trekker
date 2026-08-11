import { IsString, Matches, MinLength } from "class-validator";

/**
 * Both endpoints take the same two parameters. The path is only shape-checked
 * here — deciding whether it is *allowed* is the guard's job, on the target
 * host, after resolution (TRE-11). A validator that tried to judge safety by
 * pattern would be the string inspection that ticket exists to replace.
 */
export class FsQueryDto {
  @IsString()
  @MinLength(1, { message: "hostId is required" })
  hostId!: string;

  @IsString()
  @Matches(/^\//, { message: "path must be absolute" })
  path!: string;
}
