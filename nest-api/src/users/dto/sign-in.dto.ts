import { IsEmail, IsString } from "class-validator";

export class SignInDto {
  @IsEmail({}, { message: "A valid email is required" })
  email!: string;

  // No MinLength here on purpose: rejecting a short password at sign-in tells
  // an attacker the policy without them ever having an account.
  @IsString()
  password!: string;
}
