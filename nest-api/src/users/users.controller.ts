import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { Audited, NotAudited } from "@audit/audited.decorator";
import { LIMITS } from "@audit/limits";
import { RedisService } from "@redis/redis.service";
import { clearCsrfToken, getOrCreateCsrfToken, rotateCsrfToken } from "@users/csrf-token.util";
import { AddUserDto } from "@users/dto/add-user.dto";
import { ChangePasswordDto } from "@users/dto/change-password.dto";
import { RecoverDto } from "@users/dto/recover.dto";
import { SignInDto } from "@users/dto/sign-in.dto";
import { CsrfGuard } from "@users/guards/csrf.guard";
import { type AuthenticatedRequest, SessionAuthGuard } from "@users/guards/session-auth.guard";
import { SignupGuard, signupsOpen } from "@users/guards/signup.guard";
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

  /**
   * Public, and deliberately so: the registration screen has to know whether
   * to render a form or an explanation, and finding out by submitting and
   * being refused is a worse experience than being told. It leaks nothing an
   * attacker could not learn by pressing the button once.
   */
  @Get("signup-status")
  signupStatus(): { open: boolean } {
    return { open: signupsOpen() };
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @NotAudited(
    "Authentication events cannot live in ActivityLog: its userId is a NOT NULL foreign key, " +
      "and this row would have to be written before the handler has decided who — or whether — " +
      "anyone is signing in. A failed attempt against an address with no account has no user at " +
      "all, and those are the attempts most worth recording. Needs its own table. See TRE-47.",
  )
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
  @NotAudited(
    "The account being created does not exist when the pre-write would run, so there is no user " +
      "for the row's foreign key to reference. Registration belongs in the authentication log " +
      "alongside sign-in and recovery rather than here. See TRE-47.",
  )
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
  @NotAudited(
    "There is no session here by design, and the account is only identified once the passphrase " +
      "has been checked inside the handler — after the pre-write would have had to name a user. " +
      "Recovery is an authentication event and belongs in that log. See TRE-47.",
  )
  async recover(@Body() dto: RecoverDto, @Req() req: Request): Promise<{ ok: true }> {
    await this.usersService.recover(dto.email, dto.passphrase, dto.newPassword, clientIp(req));
    return { ok: true };
  }

  @Patch("password")
  @UseGuards(SessionAuthGuard, CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Audited({
    kind: "user.password",
    // Unlike the three routes above, this one has a session: the account is
    // already known before the handler runs, so the row can be attributed and
    // pre-written like any other. A password change on an account holding SSH
    // credentials for a fleet is worth a permanent record.
    destructive: true,
    limit: LIMITS.passwordChange,
    describe: () => ({ summary: "Changed the account password" }),
  })
  async changePassword(@Body() dto: ChangePasswordDto, @Req() req: Request): Promise<{ ok: true }> {
    await this.usersService.changePassword((req as AuthenticatedRequest).user.id, dto.currentPassword, dto.newPassword);
    return { ok: true };
  }

  @Post("logout")
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  @Audited({
    kind: "user.logout",
    // Recordable where sign-in is not: the session still exists when the
    // pre-write runs, so the row has a user. The interceptor reads it from the
    // session rather than from `request.user`, because this route carries no
    // SessionAuthGuard to have set that.
    describe: () => ({ summary: "Signed out" }),
  })
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
