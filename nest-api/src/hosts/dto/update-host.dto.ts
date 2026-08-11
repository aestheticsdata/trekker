import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsHexColor,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
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
   * Replaces the whole allowlist — this is not a merge. Editing roots is
   * removing them as often as adding them, and a PATCH that could only ever
   * widen the boundary would be a strange security control.
   */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, { message: "a host with no roots can serve nothing" })
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
