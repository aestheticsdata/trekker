import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";
import { MAX_DIGEST_LENGTH } from "@fs/upload-resume";
import { MAX_SURVEY } from "@fs/upload.service";

/**
 * `POST /api/fs/upload/survey` (TRE-143).
 *
 * What the host already has, for a whole batch at once. A POST for its body and
 * nothing else: two thousand relative paths do not fit in a query string, and
 * nginx would refuse the URL long before the API saw it.
 */
export class SurveyFileDto {
  /** Relative to the destination, exactly as the upload would send it. */
  @IsString()
  @MinLength(1, { message: "name is required" })
  @MaxLength(4096)
  name!: string;

  /**
   * The claim, all three parts or none.
   *
   * Optional one by one here and read as a set by the route, because that is
   * what it is: three fields identify a partial and any two of them identify
   * nothing. A file sent without them is asking only whether its name is taken.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  size?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  mtime?: number;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_DIGEST_LENGTH)
  @Matches(/^[0-9a-f]+$/, { message: "digest must be lowercase hex." })
  digest?: string;
}

export class UploadSurveyDto {
  @IsString()
  @MinLength(1, { message: "hostId is required" })
  hostId!: string;

  /** The directory the upload is going into. Judged by the guard, not here. */
  @IsString()
  @Matches(/^\//, { message: "path must be absolute" })
  path!: string;

  @IsArray()
  @ArrayNotEmpty({ message: "Name at least one file." })
  @ArrayMaxSize(MAX_SURVEY, { message: `At most ${MAX_SURVEY} files per survey.` })
  @ValidateNested({ each: true })
  @Type(() => SurveyFileDto)
  files!: SurveyFileDto[];
}
