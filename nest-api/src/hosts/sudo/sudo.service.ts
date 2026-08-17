import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";

/**
 * Who is allowed to run something as root, on which host, for how long
 * (TRE-29).
 *
 * **The password is held here and nowhere else.** Not in `HostCredentials`,
 * not on disk, not in the Redis-backed session. That is the decision this
 * whole ticket turns on, and it runs the opposite way to the obvious one: a
 * `NOPASSWD` sudoers entry would have made the *stored* SSH credential
 * sufficient for root, so anyone reaching the master key would reach root on
 * every host. Asking for the login password and keeping it only in this map
 * means the same attacker gets the login user and stops there.
 *
 * The cost is real and worth naming: for the length of a window there is a
 * root-granting password inside the running process. It is bounded by the
 * window, erased by the sweep, and dropped on sign-out, and that is the whole
 * of the mitigation.
 *
 * **A window is `(session, host)`, never a user and never a global flag.** Two
 * browsers signed into the same account are two sessions, and one of them
 * typing a password is not the other being trusted. Opening a window on one
 * host does not open one anywhere else — that is the property that keeps a
 * mistake local, and the reason this is keyed the way it is.
 *
 * **In memory, which means one process.** `ecosystem.config.js` runs the API
 * with `instances: 1, exec_mode: "fork"`, so there is exactly one map. Moving
 * to cluster mode would silently break this: a request landing on another
 * worker would find no window and ask for the password again, and the state
 * would fragment rather than fail. Anything that changes the process model has
 * to deal with this file, and putting the password in Redis to fix it would
 * give away the property described above.
 */

/** Fifteen minutes, the number the mockup shows on the badge. */
const DEFAULT_WINDOW_MINUTES = 15;

/**
 * How long a window stays open.
 *
 * Overridable because an install with stricter habits may want five, not
 * because anything here should depend on it being fifteen.
 */
export const SUDO_WINDOW_MS = windowMs();

function windowMs(): number {
  const override = Number.parseInt(process.env.TREKKER_SUDO_WINDOW_MINUTES ?? "", 10);
  const minutes = Number.isNaN(override) || override < 1 ? DEFAULT_WINDOW_MINUTES : override;
  return minutes * 60_000;
}

/** How often expired windows are erased. Correctness never waits on this. */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * A separator that cannot appear in either half.
 *
 * Not cosmetic. `"a" + "bc"` and `"ab" + "c"` are the same string, so a join on
 * a character an id could contain is a cross-session password leak waiting for
 * the day ids stop being uuids. NUL cannot appear in one.
 */
const KEY_SEPARATOR = "\0";

interface Window {
  password: string;
  expiresAt: number;
}

/** The token that lets a test drive the clock. Unset everywhere else. */
export const SUDO_CLOCK = Symbol("SUDO_CLOCK");

@Injectable()
export class SudoService implements OnModuleInit, OnModuleDestroy {
  private readonly windows = new Map<string, Window>();
  private timer?: NodeJS.Timeout;

  constructor(@Optional() @Inject(SUDO_CLOCK) private readonly now: () => number = () => Date.now()) {}

  onModuleInit(): void {
    // `unref` for the reason RetentionService gives: a pending timer must never
    // be why the process refuses to exit during a deploy's reload.
    this.timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    // Not merely tidiness. A process on its way out should not be holding
    // passwords while it goes, however short the interval.
    this.windows.clear();
  }

  /**
   * Open a window, or restart one that is already open.
   *
   * Reopening replaces rather than extends: the new password is the one that
   * will be used, and the clock starts again. Adding to whatever was left would
   * make the fifteen minutes a floor instead of a ceiling.
   */
  open(sessionId: string, hostId: string, password: string): number {
    const expiresAt = this.now() + SUDO_WINDOW_MS;
    this.windows.set(keyFor(sessionId, hostId), { password, expiresAt });
    return expiresAt;
  }

  /**
   * The password for a live window, or null.
   *
   * Expiry is decided here rather than by the sweep, so a window is closed the
   * moment it is out of time regardless of when the timer last ran. The sweep
   * erases; this refuses.
   */
  passwordFor(sessionId: string, hostId: string): string | null {
    const key = keyFor(sessionId, hostId);
    const window = this.windows.get(key);
    if (!window) return null;
    if (window.expiresAt <= this.now()) {
      // Found expired, so erase it now rather than leaving it for the sweep.
      this.windows.delete(key);
      return null;
    }
    return window.password;
  }

  isOpen(sessionId: string, hostId: string): boolean {
    return this.passwordFor(sessionId, hostId) !== null;
  }

  /** Milliseconds left, or 0. Never negative — the UI counts this down. */
  remainingMs(sessionId: string, hostId: string): number {
    const window = this.windows.get(keyFor(sessionId, hostId));
    if (!window) return 0;
    return Math.max(0, window.expiresAt - this.now());
  }

  /** Close one window. True if there was one to close. */
  drop(sessionId: string, hostId: string): boolean {
    return this.windows.delete(keyFor(sessionId, hostId));
  }

  /**
   * Close every window a session opened, and forget its passwords.
   *
   * This is what sign-out calls. Returns how many there were, which is what the
   * audit row records — "signed out, dropped 2 sudo windows" is the sentence
   * somebody wants later.
   */
  dropSession(sessionId: string): number {
    const prefix = `${sessionId}${KEY_SEPARATOR}`;
    let dropped = 0;
    for (const key of this.windows.keys()) {
      if (key.startsWith(prefix)) {
        this.windows.delete(key);
        dropped++;
      }
    }
    return dropped;
  }

  /**
   * Erase what has run out.
   *
   * Nothing depends on this for correctness — `passwordFor` refuses an expired
   * window whether or not it has been swept. What it is for is the promise that
   * the password is *gone* after fifteen minutes rather than merely unusable,
   * which is not the same thing when the value is a root password.
   */
  sweep(): void {
    const now = this.now();
    for (const [key, window] of this.windows) {
      if (window.expiresAt <= now) this.windows.delete(key);
    }
  }

  /** How many windows are held, expired or not. Zero after a full sweep. */
  openCount(): number {
    return this.windows.size;
  }
}

function keyFor(sessionId: string, hostId: string): string {
  return `${sessionId}${KEY_SEPARATOR}${hostId}`;
}
