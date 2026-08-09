import { IsEmail, IsString, MinLength } from "class-validator";
import { MIN_PASSWORD_LENGTH } from "@users/dto/add-user.dto";

export class RecoverDto {
  @IsEmail({}, { message: "A valid email is required" })
  email!: string;

  @IsString()
  @MinLength(1, { message: "Recovery passphrase is required" })
  passphrase!: string;

  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH, {
    message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
  })
  newPassword!: string;
}
