import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { LIMITS } from "@audit/limits";
import { RateLimitService } from "@audit/rate-limit.service";
import { isDriverError } from "@hosts/drivers/driver-error";
import type { HostDriver } from "@hosts/drivers/host-driver";
import { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import { LocalDriver } from "@hosts/drivers/local.driver";
import { PathGuardService } from "@hosts/path-guard/path-guard.service";
import { toHttp } from "@fs/driver-http";
import { forcePoll, TAIL_INITIAL_LINES_DEFAULT } from "@fs/tail-limits";
import { type Subscription, TailRegistryService, type TailSubscriber } from "@fs/tail-registry.service";
import { isExecCapable } from "@fs/tail-source";

/**
 * Everything that has to be true before a byte is streamed (TRE-34 §1).
 *
 * The order is the security property, and it is the same order `FsService.list`
 * uses: the path is validated by the TRE-11 guard before any driver work
 * happens, and everything downstream operates on the *resolved* path the guard
 * returned, never on the string the client sent. A tail is a read, and reading
 * `/etc/shadow` through an SSE stream is still reading it.
 *
 * All of this runs **before** the response headers are written, which is the
 * reason it is a separate service rather than inline in the handler: a refusal
 * has to become a real 403, 404 or 409, and once `writeHead` has run the only
 * thing left to say is an `error` frame on a stream that already returned 200.
 */

export interface OpenTailArgs {
  userId: string;
  sessionId: string;
  hostId: string;
  path: string;
  lines: number | undefined;
  subscriber: TailSubscriber;
  lastEventId: number | null;
}

export interface OpenedTail extends Subscription {
  /** The resolved path, which is what the client is actually being shown. */
  realPath: string;
}

@Injectable()
export class TailService {
  constructor(
    private readonly factory: HostDriverFactory,
    private readonly guard: PathGuardService,
    private readonly registry: TailRegistryService,
    private readonly limits: RateLimitService,
  ) {}

  async open(args: OpenTailArgs): Promise<OpenedTail> {
    // Named at the call site rather than passed as a variable, deliberately:
    // `audit-coverage.spec.ts` distinguishes a limit that is enforced from one
    // that is merely mentioned by matching `consume(LIMITS.x`, and a GET has no
    // route decorator to declare one on.
    const verdict = await this.limits.consume(LIMITS.tail, args.userId);
    if (!verdict.allowed) {
      throw new HttpException(
        RateLimitService.describe(LIMITS.tail, verdict.resetSeconds),
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const driver = await this.factory.forHost(args.hostId, args.userId);
    const validated = await this.guard.validate({
      driver,
      userId: args.userId,
      path: args.path,
      intent: "read",
    });

    const stat = await this.run(() => driver.stat(validated.realPath));
    if (stat.kind !== "file") {
      // Not tidiness. A poller pointed at a FIFO blocks on the ranged read and
      // never returns, holding a pool lease for as long as the process lives.
      throw new BadRequestException(`${args.path} is not a regular file, so it cannot be tailed.`);
    }

    const subscription = this.registry.subscribe({
      driver,
      hostId: args.hostId,
      realPath: validated.realPath,
      sessionId: args.sessionId,
      initialLines: args.lines ?? TAIL_INITIAL_LINES_DEFAULT,
      lastEventId: args.lastEventId,
      subscriber: args.subscriber,
      preferExec: this.preferExec(driver),
    });

    return { ...subscription, realPath: validated.realPath };
  }

  /**
   * Whether this host gets a real `tail -F` or the poller.
   *
   * Only a LOCAL driver gets the command, and the reason is in `tail-source.ts`:
   * over SSH there is no way to kill it. The check is `instanceof` rather than
   * a transport field, because what matters is the implementation that will
   * actually run the process — the factory is the only thing that knows the
   * transport, and it has already used it to decide which class to build.
   *
   * `execStream` being present is checked as well, because it is optional on
   * the interface: a driver that cannot stream would otherwise fail at the
   * first read rather than fall back to the poller.
   */
  private preferExec(driver: HostDriver): boolean {
    if (forcePoll()) return false;
    return driver instanceof LocalDriver && isExecCapable(driver);
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ForbiddenException) throw error; // A guard refusal is already shaped.
      if (isDriverError(error)) throw toHttp(error);
      throw error;
    }
  }
}
