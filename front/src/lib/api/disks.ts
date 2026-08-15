import { apiRequest } from "@lib/api/client";

/**
 * How full a host's filesystems are (TRE-31's route, TRE-33's panel).
 *
 * Everything here is a real JSON number, unlike the scan payloads next door: a
 * filesystem is measured in kibibytes by `df` and multiplied by 1024, which
 * stays inside a double until the volume passes eight petabytes. Nothing needs
 * to be parsed out of a string on the way in.
 *
 * `warn` is the server's, not ours. The threshold is a policy it owns and can
 * be tuned per install, so the panel draws the flag rather than comparing
 * against a number of its own — see `DISK_WARN_PERCENT` in the API.
 */

export interface DiskInodes {
  total: number;
  used: number;
  available: number;
  /** 0-100, from used over total. */
  percent: number;
}

export interface DiskMount {
  mountPoint: string;
  device: string;
  /** As `df -T` reports it, or null on a host whose `df` has no `-T` to give. */
  type: string | null;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  /** 0-100, from used over total. Never `df`'s own `Capacity` column. */
  percent: number;
  /** Full enough to draw amber. */
  warn: boolean;
  /** Null where the filesystem keeps no inode count — btrfs, and BSD's dash. */
  inodes: DiskInodes | null;
  /** `tmpfs` and friends, which the default view leaves out. */
  pseudo: boolean;
}

export async function fetchDisks(hostId: string): Promise<DiskMount[]> {
  return (await apiRequest(`/hosts/${hostId}/disks`)) as DiskMount[];
}
