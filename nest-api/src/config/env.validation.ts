import { plainToInstance } from "class-transformer";
import {
  IsIn,
  IsNumberString,
  IsOptional,
  IsString,
  IsUrl,
  MinLength,
  validateSync,
  ValidationError,
} from "class-validator";

/**
 * Boot-time contract. Every variable the API needs is declared here, and a
 * missing or malformed one stops the process at startup instead of surfacing
 * as a confusing failure on the first request that happens to need it.
 *
 * Keep this in sync with `ecosystem.config.example.js` — a variable added to
 * one and not the other is a review failure (TRE-5).
 */
class EnvironmentVariables {
  /**
   * Listen address. Optional: unset means 127.0.0.1, which is right everywhere
   * nginx fronts the API — binding wider is an explicit decision, never a
   * default (TRE-40).
   */
  @IsOptional()
  @IsString()
  @MinLength(1, { message: "HOST, when set, must not be empty" })
  HOST?: string;

  @IsNumberString({}, { message: "PORT must be a number" })
  PORT!: string;

  @IsString()
  @MinLength(1, { message: "DATABASE_URL must not be empty" })
  DATABASE_URL!: string;

  @IsString()
  @MinLength(1, { message: "REDIS_URL must not be empty" })
  REDIS_URL!: string;

  @IsUrl(
    { require_tld: false, require_protocol: true },
    { message: "FRONTEND_URL must be an absolute URL, e.g. http://localhost:3000" },
  )
  FRONTEND_URL!: string;

  @IsString()
  @MinLength(32, {
    message: "SESSION_SECRET must be at least 32 characters — generate one with `openssl rand -base64 48`",
  })
  SESSION_SECRET!: string;

  /**
   * Declared, so a typo is a boot failure rather than a silently open door.
   * The guard itself only accepts the exact string "true" (TRE-7).
   */
  @IsIn(["true", "false"], { message: 'SIGNUPS_ENABLED must be "true" or "false"' })
  SIGNUPS_ENABLED!: string;
}

export function validate(config: Record<string, unknown>): EnvironmentVariables {
  const validatedConfig = plainToInstance<EnvironmentVariables, Record<string, unknown>>(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors: ValidationError[] = validateSync(validatedConfig, { skipMissingProperties: false });

  if (errors.length > 0) {
    // Name the offending variables plainly. A validation dump that buries the
    // variable name in a class-validator object costs minutes every time.
    const details = errors
      .map((error) => `  ${error.property}: ${Object.values(error.constraints ?? {}).join(", ")}`)
      .join("\n");
    throw new Error(`Invalid environment.\n${details}\n\nSee nest-api/ecosystem.config.example.js.`);
  }

  return validatedConfig;
}
