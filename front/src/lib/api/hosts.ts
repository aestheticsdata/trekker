import { apiRequest } from "@lib/api/client";

/**
 * Hosts (TRE-12), as much of them as the explorer needs.
 *
 * The sidebar owns choosing between them (TRE-18); until it exists the
 * explorer takes the first host it is given, which on a fresh install is the
 * local one.
 */

export interface HostView {
  id: string;
  slug: string;
  label: string;
  transport: "LOCAL" | "SSH";
  address: string | null;
  port: number;
  username: string | null;
  /** The accent the pane edge and the host dot take. */
  colour: string;
  homePath: string;
  hasCredential: boolean;
}

export async function fetchHosts(): Promise<HostView[]> {
  return (await apiRequest("/hosts")) as HostView[];
}
