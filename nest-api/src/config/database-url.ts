/**
 * `DATABASE_URL` is one variable rather than a set of discrete host/user/
 * password ones, so there is nothing to drift apart. Everything that needs a
 * connection — Prisma, the health pool, the seed, the schema tests — parses it
 * here rather than growing its own copy.
 */
export interface DatabaseConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export function parseDatabaseUrl(url: string | undefined): DatabaseConnection {
  if (!url) {
    throw new Error("DATABASE_URL is required. Copy nest-api/.env.example to .env.");
  }

  const parsed = new URL(url);
  return {
    // The mariadb driver resolves "localhost" to ::1, where MySQL is usually
    // not listening on a dev machine.
    host: parsed.hostname === "localhost" ? "127.0.0.1" : parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ""),
  };
}

/** Safe to log: names the target without the password. */
export function describeTarget({ host, port, database }: DatabaseConnection): string {
  return `${host}:${port}/${database}`;
}
