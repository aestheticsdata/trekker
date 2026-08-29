import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsHexColor,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";
import { CREDENTIAL_KINDS, type CredentialKindInput } from "@hosts/dto/host-credential.dto";
import { HostRootInput, MAX_ROOTS } from "@hosts/dto/host-root.dto";

/**
 * Every field optional — a PATCH changes only what it names. Transport is not
 * here: a host does not change what kind of host it is. Supplying a credential
 * replaces the stored one and evicts the pooled connection.
 */
export class UpdateHostDto {
  @IsOptional()
  @IsString()
  @MinLength(1, { message: "label must not be empty" })
  label?: string;

  @IsOptional()
  @IsHexColor({ message: "colour must be a hex colour, e.g. #7fa8c9" })
  colour?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\//, { message: "homePath must be absolute" })
  homePath?: string;

  /**
   * Which listing columns a pane hides when it binds to this host (TRE-127),
   * comma-separated.
   *
   * Here rather than on `CreateHostDto`: a host that has just been added has
   * never been arranged, and a create that could preset this would be offering
   * a decision nobody is in a position to make yet. The default on the column
   * says the same thing and says it once.
   *
   * Shape only, like `glob` on the layout DTOs. Which names are real is the
   * front's vocabulary and this class would be a second copy of it, stale on
   * the day a column is added; the front drops what it cannot recognise on the
   * way back out, which fails towards a column showing rather than a column
   * nobody can find.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-z,]*$/, { message: "hiddenColumns must be comma-separated column names" })
  hiddenColumns?: string;

  /**
   * Replaces the whole allowlist — this is not a merge. Editing roots is
   * removing them as often as adding them, and a PATCH that could only ever
   * widen the boundary would be a strange security control. Including, for the
   * install's owner, removing the last one — see CreateHostDto on why no floor
   * is stated here (TRE-49).
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ROOTS, { message: `a host has at most ${MAX_ROOTS} roots` })
  @ValidateNested({ each: true })
  @Type(() => HostRootInput)
  roots?: HostRootInput[];

  @IsOptional()
  @IsString()
  @MinLength(1)
  address?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @IsOptional()
  @IsString()
  @MinLength(1)
  username?: string;

  @IsOptional()
  @IsIn(CREDENTIAL_KINDS, { message: "credentialKind must be PRIVATE_KEY, PASSWORD or AGENT" })
  credentialKind?: CredentialKindInput;

  @IsOptional()
  @IsString()
  @MinLength(1)
  credentialSecret?: string;

  @IsOptional()
  @IsString()
  @Matches(/^SHA256:/, { message: "fingerprint must be an SHA256:... string" })
  fingerprint?: string;

  @IsOptional()
  @IsString()
  fingerprintAlgorithm?: string;
}
