export interface RouteLogDevice {
  ip?: string;
  userAgent?: string;
}

/**
 * Formats a route log line with colors for method, path, query params, target and device (IP, User-Agent).
 */
export function formatRouteLog(
  method: string,
  url: string,
  target: "Nest" | "Express",
  device?: RouteLogDevice,
): string {
  try {
    const [path, query] = String(url ?? "").split("?");
    const queryShort = query ? ` ?${Object.keys(Object.fromEntries(new URLSearchParams(query))).join(", ")}` : "";
    const Colors = {
      r: "\x1b[0m",
      g: "\x1b[32m",
      y: "\x1b[33m",
      c: "\x1b[36m",
      d: "\x1b[2m",
      b: "\x1b[1m",
    };
    const t = target === "Nest" ? `${Colors.b}${Colors.g}Nest${Colors.r}` : `${Colors.b}${Colors.y}Express${Colors.r}`;
    const ipPart = device?.ip ? ` ${Colors.d}[${device.ip}]${Colors.r}` : "";
    const userAgentPart = device?.userAgent ? ` ${Colors.d}${device.userAgent}${Colors.r}` : "";
    return `${Colors.g}[Route]${Colors.r} ${Colors.c}${method.padEnd(6)}${Colors.r} ${path}${Colors.d}${queryShort}${Colors.r} ${Colors.d}→${Colors.r} ${t}${ipPart}${userAgentPart}`;
  } catch {
    return `[${method}] ${url} → ${target}`;
  }
}
