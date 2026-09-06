/**
 * Refusing to shoot before there is anything to shoot.
 *
 * Without this the first thing that happens is `demo.setup.ts` reporting
 * `net::ERR_CONNECTION_REFUSED` with a stack pointing into a file about signing
 * in — which says nothing about the actual problem, and sends you looking at
 * credentials. The demo has three preconditions and none of them are the
 * script's to fix, so it names them instead.
 */

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3005";

/**
 * The API is a second origin here, not a path under the front.
 *
 * Trekker's browser client is same-origin in production because nginx puts both halves behind one
 * domain; on a laptop `NEXT_PUBLIC_API_ORIGIN` (TRE-148) tells a production build where Nest is,
 * baked in at `next build`. So probing `${BASE_URL}/api` would prove nothing: Next answers 404 there
 * whether the API is up or not.
 */
const API_URL = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:6800";

async function reachable(url: string): Promise<boolean> {
  try {
    // Any answer at all is enough — a 401 or a redirect still proves something
    // is listening, which is the whole question here.
    await fetch(url, { signal: AbortSignal.timeout(3000), redirect: "manual" });
    return true;
  } catch {
    return false;
  }
}

export default async function preflight(): Promise<void> {
  const problems: string[] = [];

  if (!(await reachable(`${BASE_URL}/login`))) {
    problems.push(
      `Nothing is listening on ${BASE_URL}.\n` +
        "    The demo films the explorer; it does not start it. In two shells:\n" +
        "      cd nest-api && pnpm dev\n" +
        "      cd front && NEXT_PUBLIC_API_ORIGIN=http://localhost:6800 pnpm build && pnpm exec next start -p 3005 -H 127.0.0.1\n" +
        "    Shoot against the built front, not `pnpm dev` — a dev build floats\n" +
        "    its own overlays over the app.",
    );
  } else if (!(await reachable(`${API_URL}/api/health`))) {
    problems.push(
      `${BASE_URL} answers, but the Nest API does not answer on ${API_URL}.\n` +
        "    Start it with `cd nest-api && pnpm dev` (it listens on 6800).",
    );
  }

  if (!process.env.DEMO_USERNAME || !process.env.DEMO_PASSWORD) {
    problems.push("DEMO_USERNAME and DEMO_PASSWORD are missing from front/.env.test.local.");
  }

  if (problems.length > 0) {
    throw new Error(`\n\n  The demo cannot record yet:\n\n  - ${problems.join("\n\n  - ")}\n`);
  }
}
