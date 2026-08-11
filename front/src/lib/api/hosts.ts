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
  homeDir: string | null;
  remoteUser: string | null;
  detail: string;
}

export async function fetchHosts(): Promise<HostView[]> {
  return (await apiRequest("/hosts")) as HostView[];
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
