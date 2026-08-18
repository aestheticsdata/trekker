import { apiRequest } from "@lib/api/client";

/**
 * Hosts (TRE-12), and managing them (TRE-43).
 *
 * Nothing here ever carries a credential back: `hasCredential` and
 * `credentialKind` are the whole story the server will tell about a stored
 * secret, by design (TRE-8). Sending one is a one-way trip.
 */

export type Transport = "LOCAL" | "SSH";
export type RootAccess = "READ" | "WRITE";
export type CredentialKind = "PRIVATE_KEY" | "PASSWORD" | "AGENT";

/** One entry of the allowlist. WRITE implies READ; there is no third level. */
export interface HostRoot {
  path: string;
  access: RootAccess;
}

export interface HostFingerprint {
  algorithm: string;
  fingerprint: string;
  /** False when it was accepted on first sight and never checked out of band. */
  verified: boolean;
}

export interface HostView {
  id: string;
  slug: string;
  label: string;
  transport: Transport;
  address: string | null;
  port: number;
  username: string | null;
  /** The accent the pane edge and the host dot take. */
  colour: string;
  homePath: string;
  hasCredential: boolean;
  credentialKind: CredentialKind | null;
  roots: HostRoot[];
  fingerprints: HostFingerprint[];
  /**
   * Milliseconds left on *this browser session's* sudo window for this host,
   * or 0 (TRE-29).
   *
   * Per session rather than per account, because the window is: two browsers
   * signed into the same login see different numbers here and both are right.
   * A number rather than an optional for the reason the API gives it as one —
   * absent and expired would render identically, and one of them would be a
   * bug nobody could see.
   *
   * A reading, not a clock. It is true as of the moment `GET /hosts` answered
   * and goes stale from there, so whatever counts down from it has to anchor
   * itself to an instant rather than re-reading this field every second.
   */
  sudoRemainingMs: number;
}

/** What a create or a patch may carry. Every field optional on the wire. */
export interface HostInput {
  label?: string;
  transport?: Transport;
  colour?: string;
  homePath?: string;
  roots?: HostRoot[];
  address?: string;
  port?: number;
  username?: string;
  credentialKind?: CredentialKind;
  /** Key material, a password, or an agent socket path. Sent once, never read back. */
  credentialSecret?: string;
  fingerprint?: string;
  fingerprintAlgorithm?: string;
}

/** A dry-run connection, persisting nothing (TRE-12 §2). */
export interface HostProbeInput {
  /** Sent when re-testing a saved host, so the probe can hold it to its pins. */
  hostId?: string;
  address: string;
  port?: number;
  username: string;
  credentialKind: CredentialKind;
  credentialSecret: string;
  credentialPassphrase?: string;
}

export interface HostProbeResult {
  reachable: boolean;
  authenticated: boolean;
  /** Present even when auth failed — the handshake happens first. */
  fingerprint: string | null;
  /** The algorithm that fingerprint belongs to: a pin is the pair, not the hash. */
  fingerprintAlgorithm: string | null;
  /** The handshake was refused: this key is not what the host is pinned to. */
  hostKeyMismatch: boolean;
  /** What the host is pinned to for the offered algorithm. */
  pinnedFingerprint: string | null;
  homeDir: string | null;
  remoteUser: string | null;
  detail: string;
}

/**
 * What a host reports about itself (TRE-12). Five probes over one channel,
 * cached 5s server-side — cheap enough for the sidebar to ask per host, which
 * is the only place a real ping comes from: `GET /hosts` carries none.
 *
 * Every field is independently nullable: a host without /proc answers with
 * nulls rather than failing.
 */
export interface HostSummary {
  uptimeSeconds: number | null;
  load: { one: number; five: number; fifteen: number } | null;
  memory: { totalKb: number; availableKb: number } | null;
  pingMs: number | null;
  homeDir: string | null;
  remoteUser: string | null;
}

/**
 * What a host is doing right now (TRE-73) — the top bar's cpu, ram, io and load.
 *
 * Separate from the summary, and asked for separately, because it is a slower
 * question: cpu and io are rates, so the server reads the counters twice a
 * second apart before it can answer. The summary describes every host in the
 * sidebar; this describes the one the panes are pointed at.
 */
export interface HostMetrics {
  /** Every core aggregated, 0-100. */
  cpuPercent: number | null;
  memory: { totalKb: number; availableKb: number } | null;
  /** Reads and writes together. */
  io: { bytesPerSec: number } | null;
  load: { one: number; five: number; fifteen: number } | null;
  /** Recent 1-minute load, oldest first — the sparkline's samples. */
  history: number[];
}

export async function fetchHosts(): Promise<HostView[]> {
  return (await apiRequest("/hosts")) as HostView[];
}

export async function fetchHostSummary(id: string): Promise<HostSummary> {
  return (await apiRequest(`/hosts/${id}/summary`)) as HostSummary;
}

export async function fetchHostMetrics(id: string): Promise<HostMetrics> {
  return (await apiRequest(`/hosts/${id}/metrics`)) as HostMetrics;
}

export async function createHost(input: HostInput, csrfToken: string | null): Promise<HostView> {
  return (await apiRequest("/hosts", { method: "POST", body: input, csrfToken })) as HostView;
}

export async function updateHost(id: string, input: HostInput, csrfToken: string | null): Promise<HostView> {
  return (await apiRequest(`/hosts/${id}`, { method: "PATCH", body: input, csrfToken })) as HostView;
}

export async function deleteHost(id: string, csrfToken: string | null): Promise<void> {
  await apiRequest(`/hosts/${id}`, { method: "DELETE", csrfToken });
}

export async function testHost(input: HostProbeInput, csrfToken: string | null): Promise<HostProbeResult> {
  return (await apiRequest("/hosts/test", { method: "POST", body: input, csrfToken })) as HostProbeResult;
}

/**
 * Replace the pinned host key, deliberately (TRE-10 §3).
 *
 * Its own call rather than a field on `updateHost`, because that is the point:
 * a key change must not ride along on the save that also renamed the host. The
 * algorithm and fingerprint name the exact key being trusted, so accepting is
 * a decision about a key the user read, not about whatever answers next.
 */
export async function acceptHostKey(
  id: string,
  key: { algorithm: string; fingerprint: string },
  csrfToken: string | null,
): Promise<void> {
  await apiRequest(`/hosts/${id}/known-keys`, { method: "POST", body: key, csrfToken });
}
