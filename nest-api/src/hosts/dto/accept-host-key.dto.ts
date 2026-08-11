import { IsString, Matches, MaxLength } from "class-validator";

/**
 * Replacing a pinned host key, deliberately (TRE-10 §3).
 *
 * Both fields are required and neither has a default. Accepting "whatever the
 * host is offering now" would be the same click as a retry button, which is
 * what this endpoint exists instead of: the caller has to name the key it
 * decided to trust, so the decision survives the host changing again between
 * the warning being shown and the button being pressed.
 */
export class AcceptHostKeyDto {
  /** The SSH algorithm the fingerprint belongs to — "ssh-ed25519", "ssh-rsa". */
  @IsString()
  @MaxLength(32)
  @Matches(/^[a-z0-9][a-z0-9@.-]*$/i, {
    message: "algorithm must be an SSH algorithm name",
  })
  algorithm!: string;

  @IsString()
  @MaxLength(128)
  @Matches(/^SHA256:[A-Za-z0-9+/]{43}$/, {
    message: "fingerprint must be an unpadded SHA256:... string, as `ssh-keygen -lf` prints it",
  })
  fingerprint!: string;
}
