import { isServerActionRequest } from "@lib/proxy/serverAction";
import { NextResponse } from "next/server";

import type { NextRequest } from "next/server";

/**
 * Answers every `Next-Action` request with a bare 400 before Next sees it
 * (TRE-154). Scanners POST a junk action id to every Next site; whatever
 * reaches Next's action handler is logged as an error with a stack, and the
 * flood trips the log alert. The front has no Server Actions, so none of these
 * requests is worth a log line.
 */
const proxy = (request: NextRequest): NextResponse =>
  isServerActionRequest(request.headers) ? new NextResponse(null, { status: 400 }) : NextResponse.next();

export default proxy;

// Only requests that carry the header reach the function at all; the static
// assets are left out as the docs advise.
export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image).*)",
      has: [{ type: "header", key: "next-action" }],
    },
  ],
};
