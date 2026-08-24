import { IsString } from "class-validator";

export class UndoPermissionsDto {
  @IsString()
  activityLogId!: string;
}
