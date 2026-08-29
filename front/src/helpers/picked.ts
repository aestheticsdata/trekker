/**
 * What a gesture picked, and where each file goes (TRE-126).
 *
 * A `File` knows its name and nothing about the folder it came from, so a tree
 * has to be carried alongside it. Both ways of choosing produce the same shape
 * here — the picker, which sets `webkitRelativePath`, and a drop, which sets
 * nothing at all and has to be walked.
 *
 * The path is always relative to the destination: `a.jpg` for a flat pick,
 * `photos/2019/a.jpg` for one inside a chosen folder. It is what goes in the
 * part's filename, and the server parses it with `safeRelativePath`.
 */

export interface PickedFile {
  readonly file: File;
  /** Where it goes under the destination, separators and all. */
  readonly path: string;
}

/**
 * How many files one gesture may collect.
 *
 * A dropped home directory is not a thing to find out about by running out of
 * memory. The number is high enough that no real folder meets it and low enough
 * that the walk is over in a moment — and when it is met, `truncated` says so
 * and the modal repeats it. A cap nobody is told about reads as "it uploaded
 * everything", which is the one thing it did not do.
 */
export const MAX_PICKED = 2000;

export interface Picked {
  readonly files: readonly PickedFile[];
  /** True when the walk stopped at `MAX_PICKED` with more left. */
  readonly truncated: boolean;
}

/** Whether a path's last segment is a dotfile — `.DS_Store` and its relatives. */
export function isDotFile(path: string): boolean {
  return (path.split("/").at(-1) ?? "").startsWith(".");
}

/**
 * The picker's answer.
 *
 * `webkitRelativePath` is set only when the input carried `webkitdirectory`,
 * and is the empty string otherwise — so the fallback is the flat case rather
 * than an error.
 */
export function pickedFromInput(list: FileList | null): Picked {
  const chosen = [...(list ?? [])];
  return {
    files: chosen.slice(0, MAX_PICKED).map((file) => ({ file, path: file.webkitRelativePath || file.name })),
    truncated: chosen.length > MAX_PICKED,
  };
}

/**
 * The entries a drop is carrying, read **synchronously**.
 *
 * This must be called inside the drop handler, before anything is awaited:
 * `dataTransfer.items` is emptied when the handler returns, so a walk that
 * begins with an `await` finds an empty list and the drop silently does
 * nothing. The `FileSystemEntry` objects themselves stay valid afterwards,
 * which is what makes the split into two functions work at all.
 */
export function entriesOf(transfer: DataTransfer): FileSystemEntry[] {
  const entries: FileSystemEntry[] = [];
  for (const item of transfer.items) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry();
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

/** The same drop's plain files, for a browser that gave us no entries. */
export function filesOf(transfer: DataTransfer): Picked {
  const chosen = [...transfer.files];
  return {
    files: chosen.slice(0, MAX_PICKED).map((file) => ({ file, path: file.name })),
    truncated: chosen.length > MAX_PICKED,
  };
}

export interface DroppedItems {
  /** Captured synchronously, so a folder can be walked afterwards. */
  readonly entries: readonly FileSystemEntry[];
  /** The same drop read flatly, for an engine that hands back no entries. */
  readonly flat: Picked;
}

/**
 * Everything a drop is carrying, read before the handler returns.
 *
 * Both readings, because the fallback cannot be taken later either: once the
 * handler has returned, `dataTransfer` is empty both ways. Cheap — the flat
 * read is a `FileList` copy — and it is what makes the walk safe to `await`.
 */
export function droppedFrom(transfer: DataTransfer): DroppedItems {
  return { entries: entriesOf(transfer), flat: filesOf(transfer) };
}

/** The drop, resolved: the walk where there is one, the flat list otherwise. */
export function pickedFromDrop(dropped: DroppedItems): Promise<Picked> {
  if (dropped.entries.length === 0) return Promise.resolve(dropped.flat);
  return pickedFromEntries(dropped.entries);
}

/** Walks what `entriesOf` captured, depth first, into flat picked files. */
export async function pickedFromEntries(entries: readonly FileSystemEntry[]): Promise<Picked> {
  const into: PickedFile[] = [];
  let truncated = false;

  for (const entry of entries) {
    truncated = (await collect(entry, "", into)) || truncated;
  }

  return { files: into, truncated };
}

/** Returns whether it stopped early. */
async function collect(entry: FileSystemEntry, prefix: string, into: PickedFile[]): Promise<boolean> {
  if (into.length >= MAX_PICKED) return true;

  if (entry.isFile) {
    const file = await fileOf(entry as FileSystemFileEntry);
    if (file !== null) into.push({ file, path: `${prefix}${entry.name}` });
    return false;
  }

  if (!entry.isDirectory) return false;

  const reader = (entry as FileSystemDirectoryEntry).createReader();
  let stopped = false;

  // `readEntries` hands back a batch at a time — a hundred, in the engines that
  // implement it — and signals the end with an empty one. Calling it once reads
  // the first hundred children and silently loses every other, which is the
  // classic way this walk goes wrong and the reason for the loop.
  for (;;) {
    const batch = await readBatch(reader);
    if (batch.length === 0) return stopped;

    for (const child of batch) {
      stopped = (await collect(child, `${prefix}${entry.name}/`, into)) || stopped;
    }
  }
}

function fileOf(entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise((resolve) => {
    entry.file(
      (file) => resolve(file),
      // A file that vanished between the drop and the walk, or one the browser
      // will not hand over. One missing file is not worth failing the drop.
      () => resolve(null),
    );
  });
}

function readBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve) => {
    reader.readEntries(
      (batch) => resolve([...batch]),
      () => resolve([]),
    );
  });
}
