import { CanActivate, ForbiddenException, Injectable } from "@nestjs/common";

/**
 * Sign-ups are closed unless SIGNUPS_ENABLED is exactly "true".
 *
 * The version this was taken from closes only on the literal string "false", so a typo or a
 * missing variable leaves registration open. That default is wrong for an app
 * that stores SSH credentials and is deployed from a public repo: anyone who
 * finds the host gets an account. Closed unless explicitly opened.
 */
/**
 * The one reading of the flag. The guard enforces it and `/users/signup-status`
 * reports it, and both come through here so the screen can never say the door
 * is open while the guard is closing it.
 */
export function signupsOpen(): boolean {
  return process.env.SIGNUPS_ENABLED === "true";
}

@Injectable()
export class SignupGuard implements CanActivate {
  canActivate(): boolean {
    if (!signupsOpen()) {
      throw new ForbiddenException("Sign-ups are currently disabled");
    }

    return true;
  }
}
