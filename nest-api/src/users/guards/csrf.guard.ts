import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { hasAuthenticatedSession, hasValidCsrfToken, isSafeHttpMethod } from "@users/csrf-token.util";

@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    if (isSafeHttpMethod(request.method)) {
      return true;
    }

    // Public routes still use unsafe verbs — sign in, sign up, recover — and do
    // not rely on cookie auth, so there is no cross-site request to forge.
    if (!hasAuthenticatedSession(request)) {
      return true;
    }

    if (!hasValidCsrfToken(request)) {
      throw new ForbiddenException("Invalid CSRF token");
    }

    return true;
  }
}
