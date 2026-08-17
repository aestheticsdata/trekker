import { SUDO_WINDOW_MS, SudoService } from "@hosts/sudo/sudo.service";

/**
 * The sudo window (TRE-29).
 *
 * Two claims are worth more than the rest, and both are about what the window
 * does *not* reach: a window opened on one host is not a window on another, and
 * a window opened by one session is not another session's. Everything else here
 * is about the password going away when it is supposed to.
 *
 * Time is injected rather than faked. The service takes a clock so expiry can
 * be tested by moving the number, which is both deterministic and closer to
 * what the code does than a jest timer would be.
 */

const SESSION = "session-1";
const OTHER_SESSION = "session-2";
const HOST = "host-a";
const OTHER_HOST = "host-b";
const PASSWORD = "hunter2";

/** A service whose clock the test moves by hand. */
function serviceAt(start = 1_000_000): { sudo: SudoService; advance: (ms: number) => void } {
  let now = start;
  const sudo = new SudoService(() => now);
  return { sudo, advance: (ms: number) => (now += ms) };
}

describe("opening a window", () => {
  it("hands the password back while it is open", () => {
    const { sudo } = serviceAt();

    sudo.open(SESSION, HOST, PASSWORD);

    expect(sudo.passwordFor(SESSION, HOST)).toBe(PASSWORD);
    expect(sudo.isOpen(SESSION, HOST)).toBe(true);
  });

  it("is closed until something opens it", () => {
    const { sudo } = serviceAt();

    expect(sudo.isOpen(SESSION, HOST)).toBe(false);
    expect(sudo.passwordFor(SESSION, HOST)).toBeNull();
    expect(sudo.remainingMs(SESSION, HOST)).toBe(0);
  });

  it("does not open any other host", () => {
    // The property that keeps a mistake local, and the reason the window is
    // keyed by host at all rather than being a flag on the session.
    const { sudo } = serviceAt();

    sudo.open(SESSION, HOST, PASSWORD);

    expect(sudo.isOpen(SESSION, OTHER_HOST)).toBe(false);
    expect(sudo.passwordFor(SESSION, OTHER_HOST)).toBeNull();
  });

  it("does not open the same host for another session", () => {
    // Two people signed in as the same account are two sessions, and one of
    // them typing a password is not the other one being trusted.
    const { sudo } = serviceAt();

    sudo.open(SESSION, HOST, PASSWORD);

    expect(sudo.isOpen(OTHER_SESSION, HOST)).toBe(false);
    expect(sudo.passwordFor(OTHER_SESSION, HOST)).toBeNull();
  });

  it("reports the time it has left", () => {
    const { sudo, advance } = serviceAt();

    sudo.open(SESSION, HOST, PASSWORD);
    expect(sudo.remainingMs(SESSION, HOST)).toBe(SUDO_WINDOW_MS);

    advance(60_000);
    expect(sudo.remainingMs(SESSION, HOST)).toBe(SUDO_WINDOW_MS - 60_000);
  });

  it("replaces a window rather than stacking one on it", () => {
    const { sudo, advance } = serviceAt();

    sudo.open(SESSION, HOST, "first");
    advance(60_000);
    sudo.open(SESSION, HOST, "second");

    expect(sudo.passwordFor(SESSION, HOST)).toBe("second");
    // Reopening restarts the clock; it does not add to what was left.
    expect(sudo.remainingMs(SESSION, HOST)).toBe(SUDO_WINDOW_MS);
  });
});

describe("expiry", () => {
  it("closes on time", () => {
    const { sudo, advance } = serviceAt();

    sudo.open(SESSION, HOST, PASSWORD);
    advance(SUDO_WINDOW_MS - 1);
    expect(sudo.isOpen(SESSION, HOST)).toBe(true);

    advance(1);
    expect(sudo.isOpen(SESSION, HOST)).toBe(false);
    expect(sudo.passwordFor(SESSION, HOST)).toBeNull();
  });

  it("never reports a negative time remaining", () => {
    const { sudo, advance } = serviceAt();

    sudo.open(SESSION, HOST, PASSWORD);
    advance(SUDO_WINDOW_MS * 10);

    expect(sudo.remainingMs(SESSION, HOST)).toBe(0);
  });

  it("forgets the password rather than merely refusing it", () => {
    // The distinction this ticket turns on. A window that reports itself closed
    // while the string is still in the map has not done what was promised —
    // the password is held for fifteen minutes and then it is gone.
    const { sudo, advance } = serviceAt();

    sudo.open(SESSION, HOST, PASSWORD);
    advance(SUDO_WINDOW_MS);
    sudo.sweep();

    expect(sudo.openCount()).toBe(0);
  });

  it("sweeps only what has expired", () => {
    const { sudo, advance } = serviceAt();

    sudo.open(SESSION, HOST, PASSWORD);
    advance(SUDO_WINDOW_MS - 1_000);
    sudo.open(SESSION, OTHER_HOST, PASSWORD);

    advance(1_000);
    sudo.sweep();

    expect(sudo.isOpen(SESSION, HOST)).toBe(false);
    expect(sudo.isOpen(SESSION, OTHER_HOST)).toBe(true);
  });
});

describe("closing early", () => {
  it("takes effect immediately", () => {
    const { sudo } = serviceAt();

    sudo.open(SESSION, HOST, PASSWORD);
    expect(sudo.drop(SESSION, HOST)).toBe(true);

    expect(sudo.isOpen(SESSION, HOST)).toBe(false);
    expect(sudo.passwordFor(SESSION, HOST)).toBeNull();
    expect(sudo.openCount()).toBe(0);
  });

  it("says so when there was nothing to drop", () => {
    const { sudo } = serviceAt();

    expect(sudo.drop(SESSION, HOST)).toBe(false);
  });

  it("leaves the other host alone", () => {
    const { sudo } = serviceAt();

    sudo.open(SESSION, HOST, PASSWORD);
    sudo.open(SESSION, OTHER_HOST, PASSWORD);

    sudo.drop(SESSION, HOST);

    expect(sudo.isOpen(SESSION, OTHER_HOST)).toBe(true);
  });
});

describe("signing out", () => {
  it("drops every window that session opened", () => {
    const { sudo } = serviceAt();

    sudo.open(SESSION, HOST, PASSWORD);
    sudo.open(SESSION, OTHER_HOST, PASSWORD);

    expect(sudo.dropSession(SESSION)).toBe(2);

    expect(sudo.isOpen(SESSION, HOST)).toBe(false);
    expect(sudo.isOpen(SESSION, OTHER_HOST)).toBe(false);
  });

  it("leaves another session's windows open", () => {
    const { sudo } = serviceAt();

    sudo.open(SESSION, HOST, PASSWORD);
    sudo.open(OTHER_SESSION, HOST, PASSWORD);

    sudo.dropSession(SESSION);

    expect(sudo.isOpen(OTHER_SESSION, HOST)).toBe(true);
  });

  it("keeps nothing at all once the last session goes", () => {
    const { sudo } = serviceAt();

    sudo.open(SESSION, HOST, PASSWORD);
    sudo.open(OTHER_SESSION, OTHER_HOST, PASSWORD);

    sudo.dropSession(SESSION);
    sudo.dropSession(OTHER_SESSION);

    expect(sudo.openCount()).toBe(0);
  });
});

describe("shutting down", () => {
  it("forgets every password it is holding", () => {
    // A reload during a deploy should not leave passwords in a process that is
    // on its way out, however briefly.
    const { sudo } = serviceAt();

    sudo.open(SESSION, HOST, PASSWORD);
    sudo.open(OTHER_SESSION, OTHER_HOST, PASSWORD);

    sudo.onModuleDestroy();

    expect(sudo.openCount()).toBe(0);
  });
});

describe("keys that could collide", () => {
  it("keeps a session and host apart from their concatenation", () => {
    // `a` + `bc` and `ab` + `c` are the same string once joined. A separator
    // that can appear in an id is not a separator, so this is worth pinning:
    // ids are uuids today and this would be a silent cross-session leak if
    // they ever stopped being.
    const { sudo } = serviceAt();

    sudo.open("a", "bc", "first");
    sudo.open("ab", "c", "second");

    expect(sudo.passwordFor("a", "bc")).toBe("first");
    expect(sudo.passwordFor("ab", "c")).toBe("second");
  });
});

/**
 * What the host list reports, which is what the badge counts down (TRE-29 §4).
 *
 * Read through `remainingMs` rather than `isOpen`, because the UI needs the
 * number and not the boolean — and because a window with four seconds left and
 * one with fourteen minutes are the same answer to "is it open" and very
 * different things to show somebody.
 */
describe("what the badge reads", () => {
  it("is zero for a host with no window, not undefined", () => {
    // Absent and expired would render identically, and one of them would be a
    // bug nobody could see. So the view carries a number, always.
    const { sudo } = serviceAt();

    expect(sudo.remainingMs(SESSION, HOST)).toBe(0);
    expect(typeof sudo.remainingMs(SESSION, HOST)).toBe("number");
  });

  it("counts down rather than reporting a constant", () => {
    const { sudo, advance } = serviceAt();
    sudo.open(SESSION, HOST, PASSWORD);

    const first = sudo.remainingMs(SESSION, HOST);
    advance(30_000);
    const second = sudo.remainingMs(SESSION, HOST);

    expect(second).toBe(first - 30_000);
    expect(second).toBeLessThan(first);
  });

  it("reports each host separately in the same session", () => {
    // The list renders one chip per host, and they do not share a clock.
    const { sudo, advance } = serviceAt();

    sudo.open(SESSION, HOST, PASSWORD);
    advance(60_000);
    sudo.open(SESSION, OTHER_HOST, PASSWORD);

    expect(sudo.remainingMs(SESSION, HOST)).toBe(SUDO_WINDOW_MS - 60_000);
    expect(sudo.remainingMs(SESSION, OTHER_HOST)).toBe(SUDO_WINDOW_MS);
  });
});
