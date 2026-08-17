import { IsOptional, IsString, MaxLength, MinLength } from "class-validator";

/**
 * Opening a sudo window on one host (TRE-29).
 *
 * One field, and it is the host account's own login password — the thing
 * `sudo -S` will be given. Not a Trekker password, and not a secret invented in
 * Settings: Linux has never heard of either, so neither can unlock anything on
 * the machine.
 *
 * **This value is never stored, logged or audited.** It goes to
 * `SudoService.open`, lives in memory for the length of the window, and is
 * erased. `redact.ts` catches the key name `password` on its way to an audit
 * payload as a second line of defence, but the first is that nothing here ever
 * puts it in one.
 *
 * No `@Matches`. A password's contents are the account holder's business and a
 * pattern here would refuse valid ones; the length bounds exist to keep a
 * megabyte of request body out of the process, not to have an opinion about
 * what a good password looks like. `sudo` decides whether it is right.
 */
export class OpenSudoDto {
  /**
   * Optional, and the reason is not laxness.
   *
   * A host whose account has `NOPASSWD` — most cloud images — asks for nothing,
   * and `sudo` there ignores anything sent to it. Requiring a field the client
   * cannot fill would mean inventing a value, and validating it would mean
   * pretending to check something that is not checked. So the client reads
   * `GET :id/sudo` first and sends this only when the host said it wanted one.
   *
   * Sending it when the host wants none is harmless and ignored; omitting it
   * when the host wants one is refused as `ESUDOPASSWORDNEEDED` rather than
   * quietly attempted with an empty string.
   */
  @IsOptional()
  @IsString()
  @MinLength(1, { message: "a password, if given, cannot be empty" })
  @MaxLength(1024)
  password?: string;
}
