/**
 * Trekker API configuration — the only config file. There is no .env, in
 * either environment.
 *
 * Copy to `ecosystem.config.js` and fill in. That file is NOT committed: it
 * holds secrets and this repo is public.
 *
 * PM2 reads `env_production` on the server. Locally nothing reads a PM2 config
 * on its own, so `src/config/load-env.ts` puts `env_development` into
 * process.env before Nest boots — `pnpm dev`, `prisma migrate dev`, `pnpm seed`
 * and `pnpm test:db` all take their configuration from right here. One file,
 * both environments.
 *
 * The deploy script also reads DATABASE_URL back out of the copied file for
 * the migration step, so there is exactly one place each value is written down.
 *
 * Note that `pm2 save` copies the resolved environment into ~/.pm2/dump.pm2.
 * Worth a `chmod 600` on it.
 */
const { join } = require("node:path");

// ---- local development -----------------------------------------------------
const devEnv = {
  NODE_ENV: "development",
  HOST: "127.0.0.1",
  PORT: 6800,

  DATABASE_URL: "mysql://trekker:REPLACE_ME@127.0.0.1:3306/trekker",

  // Scratch database for `prisma migrate dev`: it replays the migration
  // history into an empty database to work out the next migration and to spot
  // drift. It gets wiped on every run, which is why it cannot be `trekker`.
  SHADOW_DATABASE_URL: "mysql://trekker:REPLACE_ME@127.0.0.1:3306/trekker_shadow",

  REDIS_URL: "redis://127.0.0.1:6379",
  FRONTEND_URL: "http://localhost:3005",

  // Padded past 32 chars: env.validation rejects anything shorter and the API
  // would not boot. Local only, so it does not need to be random.
  SESSION_SECRET: "local-dev-only-not-secret-padded-to-32-chars",
  SIGNUPS_ENABLED: "true",

  // Decrypts every stored SSH credential (TRE-8). "<version>:<base64 32 bytes>".
  // Throwaway, local only — generate with:
  //   node -e "console.log('1:' + require('crypto').randomBytes(32).toString('base64'))"
  TREKKER_MASTER_KEY: "REPLACE_ME",
  // Set only during a rotation, to the key being retired. See DEPLOY.md.
  // TREKKER_MASTER_KEY_PREVIOUS: "",

  // Signs expiring download links (TRE-66). Same format, DIFFERENT VALUE —
  // generate a second one with the same command. It must never be the master
  // key above: a signed link is a signing oracle by design, and one that shares
  // its key with the credential store turns "sign this for me" into "decrypt
  // every machine we own".
  //   node -e "console.log('1:' + require('crypto').randomBytes(32).toString('base64'))"
  // There is no PREVIOUS for this one, on purpose: changing it invalidates
  // every outstanding link, which is the only way to withdraw one.
  TREKKER_DOWNLOAD_LINK_KEY: "REPLACE_ME",

  // Optional. Password for the account `pnpm seed` creates. Left unset, the
  // seed generates one and prints it.
  // SEED_PASSWORD: "",
};

// ---- production, on the server ---------------------------------------------
const prodEnv = {
  NODE_ENV: "production",

  // Loopback only — nginx is the single public entrance. Node with no bind
  // host listens on every interface, leaving the host firewall as the only
  // thing between an SSH gateway and the internet (TRE-40).
  HOST: "127.0.0.1",

  // From the fleet's port registry: block 6800-6899.
  PORT: 6800,

  DATABASE_URL: "mysql://trekker:REPLACE_ME@127.0.0.1:3306/trekker",
  REDIS_URL: "redis://127.0.0.1:6379",
  FRONTEND_URL: "https://trekker.example.com",

  // openssl rand -base64 48
  SESSION_SECRET: "REPLACE_ME",

  // Registration is closed by default. An open sign-up on an app that stores
  // SSH keys is not a feature (TRE-7).
  SIGNUPS_ENABLED: "false",

  // Decrypts every stored SSH credential (TRE-8). Generate ON THE SERVER:
  //   node -e "console.log('1:' + require('crypto').randomBytes(32).toString('base64'))"
  // The directory holding it must stay denylisted (TRE-11), otherwise a
  // signed-in user browsing the local host reads the key that unlocks every
  // other machine. The denylist, not root placement: the install's owner
  // browses without the roots binding them (TRE-48).
  TREKKER_MASTER_KEY: "REPLACE_ME",
  // Set only during a rotation, to the key being retired. See DEPLOY.md.
  // TREKKER_MASTER_KEY_PREVIOUS: "",

  // Signs expiring download links (TRE-66). Generate ON THE SERVER, with the
  // same command as above, and make sure the two values DIFFER:
  //   node -e "console.log('1:' + require('crypto').randomBytes(32).toString('base64'))"
  //
  // Why it is its own key. A signed link lets any account ask this server to
  // sign a message it chose and hand the result to somebody with no account.
  // That is safe for a key which does nothing else and unsafe for one that also
  // seals every stored SSH credential — single-purpose keys stay single-purpose.
  //
  // There is no PREVIOUS for this one, deliberately. Changing it invalidates
  // every outstanding link at once, and that is how a link already forwarded to
  // somebody is withdrawn.
  TREKKER_DOWNLOAD_LINK_KEY: "REPLACE_ME",

  // SHADOW_DATABASE_URL does NOT belong here. It exists only for
  // `prisma migrate dev`, which needs a scratch database to replay migrations
  // in. Production runs `migrate deploy`, which does no replay and no diffing.
  // Setting it here would mean a second, writable database on the server that
  // nothing ever reads.

  // ---- audit log and rate limits (TRE-30) ----------------------------------
  //
  // All optional, all with the defaults shown. `env.validation` does not
  // declare them for that reason — it lists what the API refuses to boot
  // without, and every value here has a working default. Set one only to
  // override it.
  //
  // Retention, in days. Rows that destroyed or moved data, or granted
  // privilege, are kept four times as long: they are the ones someone comes
  // looking for, always long after the fact.
  // TREKKER_AUDIT_RETENTION_DAYS: "90",
  // TREKKER_AUDIT_RETENTION_DESTRUCTIVE_DAYS: "365",
  //
  // Limits, per user. Chosen to be invisible to a person and obstructive to a
  // script. See nest-api/src/audit/limits.ts, which is the one file to read for
  // what this install actually allows.
  // TREKKER_LIMIT_HOST_MUTATIONS_PER_MIN: "30",
  // TREKKER_LIMIT_PASSWORD_CHANGES_PER_HOUR: "5",
  // TREKKER_LIMIT_PATH_REFUSALS_PER_MIN: "20",
  // TREKKER_LIMIT_PERMISSION_CHANGES_PER_MIN: "20",
  //
  // How many entries a recursive chmod or chown may touch before it is refused
  // with the count instead of started (TRE-21). Not a load setting: it is what
  // stands between a mis-aimed "recursive" and an hour of changes nobody
  // wanted. Read per request, so raising it takes effect without a restart.
  // TREKKER_RECURSIVE_ENTRY_CEILING: "10000",
  //
  // How long a sudo window stays open, in minutes (TRE-29). Fifteen is the
  // default and the number the UI shows; the modal reads this back from the
  // API rather than hardcoding it, so lowering it here lowers what the dialog
  // promises too. Read at boot — a change needs a reload.
  // TREKKER_SUDO_WINDOW_MINUTES: "15",
  //
  // Attached and overridable, all optional, defaults shown:
  //   TREKKER_LIMIT_SUDO_ATTEMPTS_PER_5MIN     5        TRE-29
  //   TREKKER_LIMIT_DELETES_PER_MIN            10       TRE-25
  //   TREKKER_LIMIT_DELETED_ENTRIES_PER_HOUR   50000    TRE-25
  //   TREKKER_LIMIT_DOWNLOADS_PER_MIN          120      TRE-26
  //   TREKKER_LIMIT_UPLOADS_PER_MIN            30       TRE-65
  //   TREKKER_LIMIT_UPLOAD_UNITS_PER_HOUR      800      TRE-65, in 64 MiB units
  //   TREKKER_LIMIT_LINK_FETCHES_PER_MIN       60       TRE-66, keyed by IP
  //   TREKKER_LIMIT_TRANSFERS_PER_MIN          20       TRE-23, copies+moves+retries
  //   TREKKER_LIMIT_HASH_JOBS_PER_MIN          20       TRE-27
  //
  // `TREKKER_LIMIT_TRANSFERS_IN_FLIGHT` is gone rather than renamed, and the
  // difference matters if you had set it: it named an in-flight cap, which a
  // window counter cannot express. That question moved to the queue settings
  // below and is now `TREKKER_TRANSFERS_IN_FLIGHT`. What stayed on this list is
  // the rate, which is a different bound with a different number.
  //
  // `TREKKER_LIMIT_HASHES_IN_FLIGHT` went the same way and for the same reason,
  // one milestone later: it was listed here as a limit waiting for TRE-27, and
  // when the operation arrived it turned out to name a concurrency cap that no
  // fixed-window counter can express. It is now `TREKKER_HASHES_IN_FLIGHT`
  // under the checksum settings below, and the rate above is the other half.

  // ---- transfers (TRE-23, TRE-26, TRE-65, TRE-66) --------------------------
  //
  // All optional, defaults shown. Set one only to override it.
  //   TREKKER_UPLOAD_MAX_BYTES   10737418240   one file's ceiling, 10 GiB
  //   TREKKER_LINK_TTL_SECONDS   900           default link life; capped at a day
  //
  // The transfer queue (TRE-23 §6). Not rate limits — a queued transfer is the
  // right answer to a busy server and a 429 is not, so these hold jobs back
  // rather than refusing them.
  //   TREKKER_TRANSFERS_IN_FLIGHT   3     how many jobs run at once
  //   TREKKER_TRANSFERS_PER_HOST    2     how many may touch one host at once.
  //                                       Keep it below the SSH pool's six, or a
  //                                       transfer takes every connection and
  //                                       browsing that host stops answering.
  //
  // An optional ceiling on how fast a transfer moves bytes, per running job.
  // Unset means unlimited, which is right on a LAN and wrong on a link somebody
  // else is also using.
  //   TREKKER_TRANSFER_MAX_BYTES_PER_SEC    e.g. "10485760" for 10 MB/s

  // ---- checksums (TRE-27) --------------------------------------------------
  //
  // How many checksum jobs run at once, across every host and account. Not a
  // rate limit — that is `TREKKER_LIMIT_HASH_JOBS_PER_MIN` above, and it bounds
  // how often somebody may start one. This bounds how much reading is happening
  // at any moment. Higher than the scans' two because a job that runs on the
  // host spends almost no CPU here; it waits on somebody else's disk.
  //   TREKKER_HASHES_IN_FLIGHT   3
  //
  // The rest of what a job costs — the file count and the byte ceiling it is
  // refused over — is not configurable and lives in
  // nest-api/src/hashes/hash-limits.ts, which is the one file to read for it.
};

module.exports = {
  apps: [
    {
      name: "trekker-api",
      // This file sits at the remote root; the deployed unit below it is the
      // whole pnpm workspace (the lockfile lives at its root), so the API
      // package is one level further down: <root>/api/nest-api. Keeping the
      // config outside `api/` is what lets it survive the release swap.
      cwd: join(__dirname, "api", "nest-api"),
      // dist/src, not dist: the Prisma client is generated to ../generated, so
      // tsc's root covers the whole package and the layout is mirrored.
      script: "dist/src/main.js",
      // ⚠️ Single fork, and TRE-29 made that load-bearing rather than merely
      // sufficient. A sudo window — and the password behind it — lives in this
      // process's memory, keyed by session and host, and nowhere else. Under
      // cluster mode the workers would each hold a different set, so a window
      // opened on one request would be missing from the next, at random, with
      // no error to read. Moving that state to Redis to make clustering safe
      // would give away the property it exists for: that the password is never
      // written anywhere a second process could read it.
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      env_development: devEnv,
      env_production: prodEnv,
    },
  ],
};
