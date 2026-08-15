"use client";

import { DISK_CELLS, filledCells } from "@helpers/disks";
import { formatTotal } from "@helpers/listing";
import { fetchDisks } from "@lib/api/disks";
import { QUERY_KEYS } from "@lib/query/keys";
import { useQuery } from "@tanstack/react-query";

import type { DiskMount } from "@lib/api/disks";
import type { HostView } from "@lib/api/hosts";
import type { ReactNode } from "react";

/**
 * The sidebar's VOLUMES panel (TRE-33 §1), built from the App mockup's markup.
 *
 * One section per mount of the *active pane's* host, which is the host the rest
 * of the chrome describes. Not every host at once: four machines with six
 * filesystems each is twenty-four rows in a 176px rail, and the question the
 * panel answers — "is the disk I am working on filling up" — is about one of
 * them.
 *
 * The row is three lines the mockup writes as one block: the mount and its
 * percentage, a ten-cell gauge, and the device, filesystem and free space
 * beneath. Amber is the server's `warn`, never a comparison made here — see
 * `DISK_WARN_PERCENT` in the API, and the pane header that has to agree with
 * this row about the same volume.
 */

export function Volumes({
  host,
  onNavigate,
}: {
  /** The active pane's host, or null when that pane is bound to nothing. */
  host: HostView | null;
  /** Point the active pane at a mount. */
  onNavigate: (host: HostView, path: string) => void;
}) {
  const {
    data: disks,
    isPending,
    isError,
  } = useQuery({
    queryKey: [QUERY_KEYS.HOST_DISKS, host?.id],
    queryFn: () => fetchDisks(host?.id as string),
    enabled: Boolean(host),
    // A filesystem does not fill in a minute, and the server caches `df` for ten
    // seconds anyway. Refetched on a slow beat so a long session does not sit on
    // a reading from an hour ago.
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
    throwOnError: false,
  });

  if (!host) return <Empty>No host in the active pane.</Empty>;
  // A disabled query never leaves `isPending`, so the guard above has to come
  // first — otherwise an unbound pane shows this forever.
  if (isPending) return <Empty>Reading df…</Empty>;
  // Before the empty arm, because "this host reports no filesystems" is a claim
  // about the machine and a failed request supports no claim about it at all.
  if (isError) return <Empty>Could not read df on this host.</Empty>;
  if (!disks || disks.length === 0) return <Empty>This host reports no filesystems.</Empty>;

  return (
    <>
      {disks.map((disk) => (
        <Volume
          key={disk.mountPoint}
          disk={disk}
          onOpen={() => onNavigate(host, disk.mountPoint)}
        />
      ))}
    </>
  );
}

function Volume({ disk, onOpen }: { disk: DiskMount; onOpen: () => void }) {
  const filled = filledCells(disk.percent);
  // The whole row is the control: the mockup makes the block clickable rather
  // than putting a link on the mount name, and a 176px row with a hit area the
  // width of `/var/log` is a row nobody hits.
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${disk.mountPoint} — ${disk.percent}% of ${formatTotal(disk.totalBytes)} used${
        disk.warn ? " (above the warning threshold)" : ""
      }. Open it in the active pane.`}
      className="hover:bg-raised block w-full px-2.5 pt-1 pb-1.75 text-left"
    >
      {/* `leading-none` on the percentage as well as the row: `text-2xs` carries
          a 16px line box of its own, which is five pixels taller than the 11px
          line it sits on and would set the height of the whole row. */}
      <span className="flex items-baseline font-mono text-xs leading-none font-medium">
        <span className="text-ink min-w-0 flex-1 truncate">{disk.mountPoint}</span>
        <span className={`ml-1.5 flex-none text-2xs leading-none ${disk.warn ? "text-warning" : "text-accent-soft"}`}>
          {disk.percent}%
        </span>
      </span>

      {/* Ten cells rather than a bar, because that is what the mockup draws and
          because a segmented gauge is read as a fraction where a continuous one
          is read as a value. Decorative: the percentage above says the same
          thing in words. */}
      <span
        aria-hidden
        className="mt-1.25 mb-1 flex gap-[0.09375rem]"
      >
        {Array.from({ length: DISK_CELLS }, (_, cell) => (
          <i
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed-length gauge, never reordered
            key={cell}
            className={`h-1.25 flex-1 ${cell < filled ? (disk.warn ? "bg-warning" : "bg-accent-soft") : "bg-line"}`}
          />
        ))}
      </span>

      <span className="text-ink-faint flex items-baseline font-mono text-caps leading-none">
        {/* The device is the half that can be long — `vg0-log`, but also a
            `/dev/mapper/…` — so it is the half that truncates. */}
        <span className="min-w-0 flex-1 truncate">
          {disk.device}
          {disk.type && ` · ${disk.type}`}
        </span>
        <span className="ml-1.5 flex-none">{formatTotal(disk.availableBytes)} free</span>
      </span>
    </button>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-ink-faint px-2.5 py-1 font-mono text-2xs">{children}</p>;
}
