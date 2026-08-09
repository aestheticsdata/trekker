import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { RedisService } from "@redis/redis.service";
import { clearCsrfToken, getOrCreateCsrfToken, rotateCsrfToken } from "@users/csrf-token.util";
import { AddUserDto } from "@users/dto/add-user.dto";
import { ChangePasswordDto } from "@users/dto/change-password.dto";
import { RecoverDto } from "@users/dto/recover.dto";
import { SignInDto } from "@users/dto/sign-in.dto";
import { CsrfGuard } from "@users/guards/csrf.guard";
import { type AuthenticatedRequest, SessionAuthGuard } from "@users/guards/session-auth.guard";
import { SignupGuard } from "@users/guards/signup.guard";
import { SESSION_COOKIE_NAME } from "@users/session.constants";
import { UsersService, type SignInResponse } from "@users/users.service";

@Controller("users")
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly redisService: RedisService,
  ) {}

  @Get("me")
  @UseGuards(SessionAuthGuard)
  async me(@Req() req: Request): Promise<SignInResponse & { csrfToken: string }> {
    const response = await this.usersService.findById((req as AuthenticatedRequest).user.id);
    return { ...response, csrfToken: getOrCreateCsrfToken(req) };
  }

  @Get("csrf")
  @UseGuards(SessionAuthGuard)
  @HttpCode(HttpStatus.OK)
  csrf(@Req() req: Request): { csrfToken: string } {
    return { csrfToken: getOrCreateCsrfToken(req) };
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  async signIn(@Body() dto: SignInDto, @Req() req: Request): Promise<SignInResponse & { csrfToken: string }> {
    const result = await this.usersService.signIn(dto.email, dto.password, clientIp(req));

    // Before adopting the new session, not after: one live session per account,
    // and a stolen cookie stops working the moment the owner signs in again.
    await this.redisService.clearSessionsForUser(result.user.id);
    (req.session as { userId?: string }).userId = result.user.id;

    return { ...result, csrfToken: rotateCsrfToken(req) };
  }

  @Post("add")
  @UseGuards(SignupGuard)
  @HttpCode(HttpStatus.CREATED)
  async addUser(
    @Body() dto: AddUserDto,
    @Req() req: Request,
  ): Promise<SignInResponse & { csrfToken: string; recoveryPassphrase: string }> {
    const result = await this.usersService.addUser(dto);
    await this.redisService.clearSessionsForUser(result.user.id);
    (req.session as { userId?: string }).userId = result.user.id;

    // recoveryPassphrase is returned exactly here and nowhere else. There is no
    // endpoint to read it back — only the hash is kept.
    return { ...result, csrfToken: rotateCsrfToken(req) };
  }

  /**
   * Public: someone who needs recovery cannot sign in, so there is no session
   * and no CSRF token to present. The throttle in the service is what protects
   * this route.
   */
  @Post("recover")
  @HttpCode(HttpStatus.OK)
  async recover(@Body() dto: RecoverDto, @Req() req: Request): Promise<{ ok: true }> {
    await this.usersService.recover(dto.email, dto.passphrase, dto.newPassword, clientIp(req));
    return { ok: true };
  }

  @Patch("password")
  @UseGuards(SessionAuthGuard, CsrfGuard)
  @HttpCode(HttpStatus.OK)
  async changePassword(@Body() dto: ChangePasswordDto, @Req() req: Request): Promise<{ ok: true }> {
    await this.usersService.changePassword((req as AuthenticatedRequest).user.id, dto.currentPassword, dto.newPassword);
    return { ok: true };
  }

  @Post("logout")
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ ok: true }> {
    clearCsrfToken(req);
    return new Promise((resolve, reject) => {
      // destroy() removes the Redis entry. Clearing the cookie alone would
      // leave a usable session behind for anyone who copied it.
      req.session.destroy((error) => {
        if (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        res.clearCookie(SESSION_COOKIE_NAME);
        resolve({ ok: true });
      });
    });
  }
}

/** Behind nginx, req.ip is the proxy unless `trust proxy` is set — it is. */
function clientIp(req: Request): string {
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}
