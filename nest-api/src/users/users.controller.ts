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

    // What this used to do inline was write the account's id onto whatever
    // session the request arrived on, which is the whole of the fixation hole
    // (TRE-92). `establishSession` holds the order and the reason for each step.
    return { ...result, csrfToken: await this.establishSession(req, result.user.id) };
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

    // The same sequence sign-in runs, for the same reason: this route opens a
    // session too, so a cookie planted on the registration screen would
    // otherwise be inherited by the account it creates (TRE-92).
    const csrfToken = await this.establishSession(req, result.user.id);

    // recoveryPassphrase is returned exactly here and nowhere else. There is no
    // endpoint to read it back — only the hash is kept.
    return { ...result, csrfToken };
  }

  /**
   * Public: someone who needs recovery cannot sign in, so there is no session
   * and no CSRF token to present. The throttle in the service is what protects
   * this route.
   *
   * No `regenerate` here, unlike sign-in and registration (TRE-92). This route
   * grants no identity, so there is none to fixate onto, and the service has
   * already destroyed every session the account held — this request's included,
   * if it happened to carry one. Nothing in the handler writes to the session,
   * so the swept record is not written back on the way out. Regenerating would
   * mint an anonymous session id for a response whose whole content is `ok`.
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

  /**
   * Everything that has to happen before a request may call itself signed in
   * (TRE-92), in the one order that is safe. Shared by the two routes that open
   * a session: sign-in and registration.
   *
   * 1. **Every session the account holds is destroyed.** One live session per
   *    account, and a stolen cookie stops working the moment the owner signs in
   *    again. The sweep matches on `userId`, so it cannot reach the session
   *    being established here: that one carries no id yet, and is not in Redis
   *    until this response ends.
   *
   *    First rather than last, and neither order is free. Sweeping first means
   *    a `regenerate` that then fails has already ended the account's other
   *    sessions and still answers 500. Sweeping after means a `regenerate` that
   *    fails skips the sweep altogether, and "one live session per account"
   *    quietly did not happen. The second is the one that fails silently, so it
   *    is the one not chosen.
   *
   * 2. **This session's sudo windows are dropped**, read off the id it still
   *    has. Windows are keyed by `sessionID` (TRE-29) and step 3 changes it, so
   *    a window left open here is a root password held in memory with nothing
   *    able to reach it. Only this session's, necessarily — `dropSession` takes
   *    one session id, and step 1 has just destroyed the account's sessions on
   *    other devices, whose windows this cannot see. That gap is older than this
   *    method and outlives it; closing it needs a userId index in `SudoService`.
   *
   * 3. **The session id is regenerated.** The fixation fix, and the reason this
   *    method exists: without it, a cookie planted in the visitor's browser —
   *    one already resolving to a live session — is written to rather than
   *    replaced, and whoever planted it keeps a working handle on the account.
   *    Step 1 never covered that case, because at sweep time the planted record
   *    still carries somebody else's `userId`.
   *
   * 4. **The identity and a fresh token go on the new object.** `regenerate`
   *    replaces `req.session` wholesale, so anything written before it is on the
   *    object it discarded. Both of these read `req.session` when called, which
   *    is what makes the order below the only one that works.
   */
  private async establishSession(req: Request, userId: string): Promise<string> {
    await this.redisService.clearSessionsForUser(userId);
    this.sudo.dropSession(req.sessionID);

    try {
      await regenerateSession(req);
    } catch (error) {
      // `regenerate` mints the replacement before it reports the failure, so a
      // rejection leaves an empty session behind that would otherwise be saved
      // and cookied on the way out with the 500. Nothing here is worth
      // remembering, so nothing is kept. The destroy's own failure is not worth
      // reporting over the one already on its way up.
      await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
      throw error;
    }

    (req.session as { userId?: string }).userId = userId;
    return rotateCsrfToken(req);
  }
}

/** Behind nginx, req.ip is the proxy unless `trust proxy` is set — it is. */
function clientIp(req: Request): string {
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}

/**
 * Promise wrapper around express-session's callback API — the same shape
 * `logout` wraps `destroy` in, and what the sibling apps that already regenerate
 * use. The error is normalised because express-session types it as `any`.
 */
function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      resolve();
    });
  });
}

/** "1 sudo window", "2 sudo windows" — the same helper the fs routes use. */
function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
