import { IsIn, IsOptional, IsString, MinLength } from "class-validator";

/**
 * The one place a private key or password enters the system. Flattened onto the
 * host DTOs rather than nested, so validation needs no class-transformer
 * ceremony and there is no object for a logger to accidentally serialise.
 *
 * `secret` is the key material, the password, or the agent socket path
 * depending on `kind`. It is encrypted before it touches the database (TRE-8)
 * and never read back out through any endpoint.
 */
export const CREDENTIAL_KINDS = ["PRIVATE_KEY", "PASSWORD", "AGENT"] as const;
export type CredentialKindInput = (typeof CREDENTIAL_KINDS)[number];

export class HostCredentialInput {
  @IsIn(CREDENTIAL_KINDS, { message: "credentialKind must be PRIVATE_KEY, PASSWORD or AGENT" })
  credentialKind!: CredentialKindInput;

  @IsString()
  @MinLength(1, { message: "credentialSecret must not be empty" })
  credentialSecret!: string;

  /** Only for an encrypted PRIVATE_KEY, and only used while testing a candidate. */
  @IsOptional()
  @IsString()
  credentialPassphrase?: string;
}
