import { IsEmail, IsString, MinLength } from "class-validator";

export const MIN_PASSWORD_LENGTH = 12;

export class AddUserDto {
  @IsEmail({}, { message: "A valid email is required" })
  email!: string;

  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH, {
    message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
  })
  password!: string;
}
