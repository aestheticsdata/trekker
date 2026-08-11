import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, Matches } from "class-validator";

/** The host's bookmarks in their new order — the whole list, not a delta. */
export class ReorderBookmarksDto {
  @IsString()
  @Matches(/^[0-9a-f-]{36}$/i, { message: "hostId must be an id" })
  hostId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @Matches(/^[0-9a-f-]{36}$/i, { each: true, message: "each id must be an id" })
  ids!: string[];
}
