import { IsIn, IsInt, IsOptional, IsString, Max, Min, MinLength } from "class-validator";
import { CREDENTIAL_KINDS, type CredentialKindInput } from "@hosts/dto/host-credential.dto";

/**
 * A candidate SSH host to dry-run connect, before anything is written (TRE-12).
 * Always SSH — there is nothing to test about the local machine. The credential
 * lives in memory for the length of the request and is never persisted, logged
 * or echoed back.
 */
export class TestHostDto {
  /**
   * The host being re-tested, when there is one (TRE-10 §2).
   *
   * Without it the probe has no pins to compare against and authenticates
   * against whatever answers, comparing afterwards — which is the ordering
   * this ticket exists to forbid, on the very screen where a key change is
   * most likely to be noticed. Absent when testing a host that does not exist
   * yet, which is a genuine first use.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  hostId?: string;

  @IsString()
  @MinLength(1)
  address!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @IsString()
  @MinLength(1)
  username!: string;

  @IsIn(CREDENTIAL_KINDS, { message: "credentialKind must be PRIVATE_KEY, PASSWORD or AGENT" })
  credentialKind!: CredentialKindInput;

  @IsString()
  @MinLength(1, { message: "credentialSecret must not be empty" })
  credentialSecret!: string;

  @IsOptional()
  @IsString()
  credentialPassphrase?: string;
}
