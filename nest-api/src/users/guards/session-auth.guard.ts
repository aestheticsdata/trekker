import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";

export interface SessionUser {
  id: string;
}

export type AuthenticatedRequest = Request & { user: SessionUser };

/**
 * Lives in `users/` rather than beside the first feature that needed it, which
 * is where pfa ended up putting it. Every module from TRE-12 onwards depends on
 * this guard; it is not the file explorer's property.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const userId = (request.session as { userId?: string } | undefined)?.userId;

    if (!userId) {
      throw new UnauthorizedException("Session required");
    }

    (request as AuthenticatedRequest).user = { id: userId };
    return true;
  }
}
