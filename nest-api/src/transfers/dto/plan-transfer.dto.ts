import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsString, MaxLength } from "class-validator";
import { MAX_PATHS } from "@fs/permissions.service";

/**
 * What a transfer would do, asked before anything is queued (TRE-23 §2).
 *
 * `MAX_PATHS` is borrowed from the permissions module for the third time, and
 * deliberately: it already means "a selection, not a filesystem", which is
 * exactly the line being drawn. The number of *entries* underneath those paths
 * is a different ceiling and is checked by the walk.
 */
export class PlanTransferDto {
  @IsString()
  @MaxLength(64)
  srcHostId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PATHS)
  @IsString({ each: true })
  @MaxLength(4096, { each: true })
  srcPaths!: string[];

  @IsString()
  @MaxLength(64)
  dstHostId!: string;

  @IsString()
  @MaxLength(4096)
  dstPath!: string;

  @IsIn(["copy", "move"])
  operation!: "copy" | "move";
}
