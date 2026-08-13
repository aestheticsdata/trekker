import { ZipFile } from "yazl";

import type { WalkedEntry } from "@fs/tree-walk";
import type { HostDriver } from "@hosts/drivers/host-driver";
import type { Readable } from "node:stream";

/**
 * A directory, as a zip that is never written down (TRE-26 §2).
 *
 * The archive is produced as it is sent. Nothing is spooled to the API's disk
 * and no entry is held in memory beyond the window the compressor is working
 * on, which is what makes downloading a directory the same operation whether it
 * holds ten files or ten thousand.
 *
 * **`addReadStreamLazy` is load-bearing, not a preference.** `addReadStream`
 * would need every entry's stream open before the first byte is sent, and on a
 * remote host each of those holds an SFTP channel out of a pool six wide — a
 * directory of seven files would deadlock before it sent anything. Lazily, yazl
 * asks for one stream, drains it, then asks for the next, so a ten-thousand
 * entry archive holds exactly one channel from beginning to end.
 *
 * `yazl` rather than `archiver`: one dependency (`buffer-crc32`) against nine,
 * and it does one thing. On a repository whose own README is about what it
 * refuses to install, the smaller supply chain is the choice that matches.
 */

/**
 * Above this apparent size, an entry is written in the zip64 format.
 *
 * Not 4 GiB but a little under it, because the size that decides this comes
 * from the walk and the bytes come from the read, and a file that grows in
 * between would otherwise be written with a 32-bit header and a 64-bit
 * descriptor — an archive that unzips with an error nobody can act on. A
 * quarter of a gigabyte of slack costs 20 bytes per large entry.
 */
const ZIP64_ENTRY_THRESHOLD = 0xf0_00_00_00;

/**
 * Extensions whose contents are already compressed.
 *
 * Deflating these spends CPU to make the file marginally bigger. The list is
 * short on purpose — it is an optimisation, and a missing entry costs a little
 * time while a wrong one costs nothing at all.
 */
const ALREADY_COMPRESSED = new Set([
  "7z",
  "avif",
  "br",
  "bz2",
  "gif",
  "gz",
  "heic",
  "jpeg",
  "jpg",
  "mkv",
  "mp3",
  "mp4",
  "png",
  "webm",
  "webp",
  "xz",
  "zip",
  "zst",
]);

export interface ZipResult {
  /** Pipe this at the response. It ends when the archive is complete. */
  stream: Readable;
  /** Entries actually written — directories included, symlinks never. */
  entries: number;
}

/**
 * Build the archive for one walked tree.
 *
 * `root` is the directory being downloaded and `entries` is `walkTree`'s output
 * for it, post-order with the root last. Every path inside the archive is made
 * relative to the root's *parent*, so extracting produces the directory rather
 * than scattering its contents into the current one.
 *
 * Symlinks are absent, which is the walk's default and the right one here: a
 * zip entry for a link is either the link (which most extractors turn into a
 * regular file holding a path) or its target's bytes (which is following a link
 * out of the roots, in an archive, on somebody else's laptop). Neither is worth
 * having, and the caller reports the count so the omission is stated rather
 * than discovered.
 */
export function zipTree(driver: HostDriver, root: string, entries: readonly WalkedEntry[]): ZipResult {
  const zip = new ZipFile();
  const parent = parentOf(root);
  let written = 0;

  for (const entry of entries) {
    const metadataPath = relativeTo(parent, entry.path);
    // The root's own entry names the directory itself; without it an archive of
    // an empty directory would contain nothing at all and extract to nothing.
    if (metadataPath === "") continue;

    if (entry.kind === "directory") {
      zip.addEmptyDirectory(metadataPath, { mtime: mtimeOf(entry), mode: modeOf(entry, 0o755) });
      written += 1;
      continue;
    }

    // Anything that is not a file and not a directory — a fifo, a socket, a
    // device node — has no bytes worth archiving and would block the pump
    // waiting for some. The walk already leaves symlinks out.
    if (entry.kind !== "file") continue;

    zip.addReadStreamLazy(
      metadataPath,
      {
        mtime: mtimeOf(entry),
        mode: modeOf(entry, 0o644),
        compress: !ALREADY_COMPRESSED.has(extensionOf(entry.path)),
        forceZip64Format: entry.size >= ZIP64_ENTRY_THRESHOLD,
      },
      (callback) => {
        // No `size`: yazl would then *enforce* it and fail the whole archive if
        // the file changed between the walk and the read. Without it the entry
        // is written with a data descriptor, which is what the format has for
        // exactly this case.
        driver.createReadStream(entry.path).then(
          (stream) => callback(null, stream),
          (error: unknown) => callback(error, null as never),
        );
      },
    );
    written += 1;
  }

  zip.end();
  return { stream: zip.outputStream as Readable, entries: written };
}

/**
 * `mtime` for a zip entry.
 *
 * Zip timestamps start in 1980 and yazl throws on anything earlier, so an entry
 * the walk could not stat — `mtimeMs: 0`, meaning 1970 — would take the whole
 * archive down. The epoch is not a date anyone is relying on here; the 1980
 * floor is the format's own and is the honest place to clamp to.
 */
function mtimeOf(entry: WalkedEntry): Date {
  const floor = Date.UTC(1980, 0, 1);
  return new Date(Math.max(entry.mtimeMs, floor));
}

/** Permission bits, falling back when the walk could not read them. */
function modeOf(entry: WalkedEntry, fallback: number): number {
  return entry.mode > 0 ? entry.mode : fallback;
}

function extensionOf(path: string): string {
  const name = path.split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * The archive-relative name of a path.
 *
 * Both arguments come from `realpath` and the walk, so `path` is always under
 * `parent` — but this returns `""` rather than trusting that, because the one
 * thing an archive entry must never be is absolute or climbing.
 */
function relativeTo(parent: string, path: string): string {
  const prefix = parent === "/" ? "/" : `${parent}/`;
  if (!path.startsWith(prefix)) return "";
  const relative = path.slice(prefix.length);
  return relative.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ? "" : relative;
}

function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return cut <= 0 ? "/" : trimmed.slice(0, cut);
}
