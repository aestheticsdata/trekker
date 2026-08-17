import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Put, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { AuditService } from "@audit/audit.service";
import { Audited, NotAudited } from "@audit/audited.decorator";
import { LIMITS } from "@audit/limits";
import { SudoService } from "@hosts/sudo/sudo.service";
import { RedisService } from "@redis/redis.service";
import { clearCsrfToken, getOrCreateCsrfToken, rotateCsrfToken } from "@users/csrf-token.util";
import { AddUserDto } from "@users/dto/add-user.dto";
import { ChangePasswordDto } from "@users/dto/change-password.dto";
import { RecoverDto } from "@users/dto/recover.dto";
import { SaveLayoutDto } from "@users/dto/save-layout.dto";
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
    private readonly sudo: SudoService,
    private readonly audit: AuditService,
  ) {}

  @Get("me")
  @UseGuards(SessionAuthGuard)
  async me(@Req() req: Request): Promise<SignInResponse & { csrfToken: string }> {
    const response = await this.usersService.findById((req as AuthenticatedRequest).user.id);
    return { ...response, csrfToken: getOrCreateCsrfToken(req) };
  }

  /**
   * The layout this account last had open (TRE-51). Null when it has never had
   * one, which is what a new account and a cold open both see.
   */
  @Get("layout")
  @UseGuards(SessionAuthGuard)
  async layout(@Req() req: Request): Promise<{ layout: unknown }> {
    return { layout: await this.usersService.lastLayout((req as AuthenticatedRequest).user.id) };
  }

  @Put("layout")
  @UseGuards(SessionAuthGuard, CsrfGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @NotAudited(
    "This fires on navigation — every path change, sort toggle and pane switch the account makes, " +
      "debounced but still routinely. A row each would be the loudest thing in ActivityLog and " +
      "would bury the operations the strip exists to show, which is the failure TRE-30 §2 names. " +
      "It also destroys nothing and grants nothing: the column holds where a session was pointed, " +
      "it is overwritten by the next write, and reading it back tells an attacker only what the " +
      "account was already looking at. Where the account HAS been is the audit trail's job, and it " +
      "records that already, per operation.",
  )
  async saveLayout(@Body() dto: SaveLayoutDto, @Req() req: Request): Promise<void> {
    await this.usersService.saveLastLayout((req as AuthenticatedRequest).user.id, dto);
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
    // Before `destroy`, and deliberately not inside its callback: the sudo
    // windows are keyed by `sessionID`, and a failed destroy must not be the
    // reason a root password stays in memory (TRE-29). Dropping them for a
    // session that then survives costs one re-prompt; the other order costs a
    // held password with nothing left to close it.
    const dropped = this.sudo.dropSession(req.sessionID);
    if (dropped > 0) this.audit.annotate(req, { summary: `Signed out, closing ${count(dropped, "sudo window")}` });

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

/** "1 sudo window", "2 sudo windows" — the same helper the fs routes use. */
function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
