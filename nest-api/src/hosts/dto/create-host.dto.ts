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
 * Create a host. LOCAL needs nothing but a label; SSH needs an address, a
 * username and a credential — enforced in the service, because "required only
 * when transport is SSH" is a rule the decorators cannot state on their own.
 */
export class CreateHostDto {
  @IsString()
  @MinLength(1, { message: "label must not be empty" })
  label!: string;

  @IsIn(["LOCAL", "SSH"], { message: "transport must be LOCAL or SSH" })
  transport!: "LOCAL" | "SSH";

  @IsOptional()
  @IsHexColor({ message: "colour must be a hex colour, e.g. #7fa8c9" })
  colour?: string;

  /** The pane's starting directory. Defaults to the API user's home for LOCAL, `/` for SSH. */
  @IsOptional()
  @IsString()
  @Matches(/^\//, { message: "homePath must be absolute" })
  homePath?: string;

  /**
   * The allowlist (TRE-11). Omitted, the host gets one WRITE root at its home,
   * which is the bootstrap default and what every host had before TRE-43. Given,
   * it is the complete list, and the home must sit inside one of them or the
   * pane would open on a refusal.
   */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, { message: "a host with no roots can serve nothing" })
  @ArrayMaxSize(MAX_ROOTS, { message: `a host has at most ${MAX_ROOTS} roots` })
  @ValidateNested({ each: true })
  @Type(() => HostRootInput)
  roots?: HostRootInput[];

  // ---- SSH only ----
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

  /**
   * The host key fingerprint to pin, "SHA256:...", taken from a prior /test.
   * Optional: without it the first connection trusts on first use (TRE-10).
   */
  @IsOptional()
  @IsString()
  @Matches(/^SHA256:/, { message: "fingerprint must be an SHA256:... string" })
  fingerprint?: string;

  @IsOptional()
  @IsString()
  fingerprintAlgorithm?: string;
}
