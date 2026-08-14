import {
  IsString,
  Matches,
  MaxLength,
  MinLength,
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from "class-validator";
import { entryNameProblem, MAX_NAME_BYTES } from "@fs/entry-name";

/**
 * `POST /api/fs/mkdir` and `POST /api/fs/create` (TRE-69 §1) — one containing
 * directory, one new entry name.
 *
 * The split between the two fields is the security property. `path` is the
 * directory the guard adjudicates; `name` is a single segment joined onto the
 * path the guard *returned*. Nothing here builds a path out of client input
 * twice, which is what makes "the guard saw the directory this lands in" a fact
 * rather than a hope.
 *
 * So the name rules run here, at the DTO, before the guard is asked anything —
 * unlike `RenameDto`, which length-checks here and meaning-checks in the
 * service because its preview has to *render* a bad name rather than throw on
 * one. There is no preview for a create: the answer is yes or it is a 400.
 */
export class CreateEntryDto {
  @IsString()
  @MaxLength(64)
  hostId!: string;

  @IsString()
  @Matches(/^\//, { message: "The path must be absolute." })
  @MaxLength(4096)
  path!: string;

  @IsString()
  @MinLength(1, { message: "Give the new entry a name." })
  // Characters here, bytes in `entryNameProblem`: a decorator counts UTF-16
  // units and a filesystem counts bytes, so this only keeps an absurd input out
  // of the code that measures properly.
  @MaxLength(MAX_NAME_BYTES)
  @IsEntryName()
  name!: string;
}

/**
 * The name rules, as a decorator, so a refusal is a 400 from the validation
 * pipe with the reason in it rather than an exception thrown three layers down.
 *
 * A custom constraint rather than a `@Matches` regex because the rules have
 * seven distinct answers and the reader of a refusal deserves to be told which
 * one they hit. "name must match /^[^/]+$/" is not a sentence anybody acts on.
 */
function IsEntryName(options?: ValidationOptions) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      name: "isEntryName",
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => typeof value === "string" && entryNameProblem(value) === null,
        defaultMessage: (args?: ValidationArguments) => {
          const value = args?.value;
          if (typeof value !== "string") return "A name is a string.";
          return entryNameProblem(value)?.message ?? "That name cannot be used.";
        },
      },
    });
  };
}
