import { IsEmail, IsOptional, IsString, MinLength } from "class-validator";

export const MIN_PASSWORD_LENGTH = 12;

/**
 * Length and nothing else. No required digit, symbol or case mix: composition
 * rules push people toward the same handful of predictable shapes, and this is
 * a phrase meant to be written down, not typed daily.
 */
export const MIN_PASSPHRASE_LENGTH = 10;

export class AddUserDto {
  @IsEmail({}, { message: "A valid email is required" })
  email!: string;

  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH, {
    message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
  })
  password!: string;

  /**
   * The recovery passphrase, chosen by whoever registers. Optional so
   * `account:create` and any non-interactive caller still get a generated one.
   */
  @IsOptional()
  @IsString()
  @MinLength(MIN_PASSPHRASE_LENGTH, {
    message: `Recovery passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`,
  })
  passphrase?: string;
}
