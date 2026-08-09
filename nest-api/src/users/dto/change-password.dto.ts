import { IsString, MinLength } from "class-validator";
import { MIN_PASSWORD_LENGTH } from "@users/dto/add-user.dto";

export class ChangePasswordDto {
  @IsString()
  currentPassword!: string;

  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH, {
    message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
  })
  newPassword!: string;
}
