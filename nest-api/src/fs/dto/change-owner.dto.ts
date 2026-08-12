import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsBoolean, IsOptional, IsString, Matches } from "class-validator";
import { MAX_PATHS } from "@fs/permissions.service";

/**
 * `POST /api/fs/chown` (TRE-21 §1).
 *
 * Either field may be omitted — changing only the group is an ordinary thing
 * to want — but not both, which the service refuses with a message rather than
 * silently doing nothing.
 *
 * The name pattern is deliberately generous: POSIX leaves valid user names to
 * the implementation, and a host with `dots.in.names` or a trailing `$` for a
 * machine account is not this API's business to reject. It is a sanity check,
 * not the security boundary — names are resolved to numeric ids and handed to
 * `chown(2)`, never to a shell.
 */
const NAME_OR_ID = /^[a-zA-Z0-9._][a-zA-Z0-9._$-]{0,31}$/;

export class ChangeOwnerDto {
  @IsString()
  hostId!: string;

  @IsArray()
  @ArrayNotEmpty({ message: "Name at least one path." })
  @ArrayMaxSize(MAX_PATHS, { message: `At most ${MAX_PATHS} paths per request.` })
  @IsString({ each: true })
  @Matches(/^\//, { each: true, message: "Every path must be absolute." })
  paths!: string[];

  @IsOptional()
  @IsString()
  @Matches(NAME_OR_ID, { message: "Owner must be a user name or a numeric uid." })
  owner?: string;

  @IsOptional()
  @IsString()
  @Matches(NAME_OR_ID, { message: "Group must be a group name or a numeric gid." })
  group?: string;

  @IsOptional()
  @IsBoolean()
  recursive?: boolean;
}
