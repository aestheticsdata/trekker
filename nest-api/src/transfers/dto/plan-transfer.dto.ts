import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength } from "class-validator";
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

  /**
   * Every selected entry lands under a name nothing at the destination holds
   * (TRE-69 §2) — `report.txt` becomes `report (2).txt`, `logs` becomes
   * `logs (2)`, from the same `numberedName` the upload path and `keepBoth`
   * already share.
   *
   * A flag rather than a client-supplied name, deliberately: the destination is
   * listed here and the free name chosen here, so no request can ask for a
   * transfer to land under a name of its own choosing. What the caller sends is
   * the *intent*, exactly as it sends a conflict strategy rather than a set of
   * decisions.
   *
   * Copies only. A move that renamed what it moved would be a rename, and this
   * application has one of those already.
   */
  @IsOptional()
  @IsBoolean()
  duplicate?: boolean;
}
