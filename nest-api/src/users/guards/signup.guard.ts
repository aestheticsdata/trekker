import { CanActivate, ForbiddenException, Injectable } from "@nestjs/common";

/**
 * Sign-ups are closed unless SIGNUPS_ENABLED is exactly "true".
 *
 * pfa's version closes only on the literal string "false", so a typo or a
 * missing variable leaves registration open. That default is wrong for an app
 * that stores SSH credentials and is deployed from a public repo: anyone who
 * finds the host gets an account. Closed unless explicitly opened.
 */
@Injectable()
export class SignupGuard implements CanActivate {
  canActivate(): boolean {
    if (process.env.SIGNUPS_ENABLED !== "true") {
      throw new ForbiddenException("Sign-ups are currently disabled");
    }

    return true;
  }
}
