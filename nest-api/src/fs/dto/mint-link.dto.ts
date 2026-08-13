import { IsInt, IsOptional, IsString, Matches, Max, Min, MinLength } from "class-validator";
import { Type } from "class-transformer";

/**
 * What a signed link is asked for (TRE-66).
 *
 * One path, never a list: the grant is one file, and a DTO that accepted an
 * array would be the first place that stopped being true.
 */
export class MintLinkDto {
  @IsString()
  @MinLength(1, { message: "hostId is required" })
  hostId!: string;

  @IsString()
  @Matches(/^\//, { message: "path must be absolute" })
  path!: string;

  /**
   * How long it lives. Optional — the server's default is short on purpose, and
   * the service clamps anything longer than a day whatever is asked for here.
   * Bounded in both places rather than only one: this refuses the nonsense, the
   * service refuses the merely optimistic.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(60, { message: "ttlSeconds must be at least a minute" })
  @Max(86_400, { message: "ttlSeconds must be at most a day" })
  ttlSeconds?: number;
}
