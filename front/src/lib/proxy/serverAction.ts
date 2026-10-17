/**
 * The header Next reads to route a request to its Server Action handler. The
 * front has no Server Actions (TRE-154), so nothing legitimate ever sends it:
 * every request that carries one is a scanner's probe.
 */
const ACTION_HEADER = "next-action";

export const isServerActionRequest = (headers: Headers): boolean => headers.has(ACTION_HEADER);
