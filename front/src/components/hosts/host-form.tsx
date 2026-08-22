"use client";

import { useAuth } from "@auth/context/AuthContext";
import { Button, Field, Segmented, TextInput } from "@components/hosts/field";
import { RootsEditor } from "@components/hosts/roots-editor";
import { zodResolver } from "@hookform/resolvers/zod";
import { ApiError } from "@lib/api/client";
import { acceptHostKey, createHost, deleteHost, fetchHosts, testHost, updateHost } from "@lib/api/hosts";
import { CREDENTIAL_LABELS, cleanPath, HOST_COLOURS, hostSchemaFor } from "@schemas/host";
import { useState } from "react";
import { useForm } from "react-hook-form";

import type { HostInput, HostProbeResult, HostView } from "@lib/api/hosts";
import type { HostFormValues } from "@schemas/host";

/**
 * Add or edit one host (TRE-43 §1, §3, §4, §5).
 *
 * The form is the only place a credential enters Trekker from a browser. It
 * goes out once, to `POST /hosts` or `PATCH /hosts/:id`, and never comes back:
 * an existing host reports that a key is stored and which kind, never the key.
 * So the secret field on an edit is blank and optional, and filling it means
 * "replace", never "confirm".
 */
export function HostForm({
  host,
  localTaken,
  onSaved,
  onDeleted,
  onCancel,
}: {
  /** Null to create. */
  host: HostView | null;
  /** Another host already holds the one LOCAL slot, so it cannot be offered. */
  localTaken: boolean;
  onSaved: (host: HostView) => void;
  onDeleted: (host: HostView) => void;
  onCancel: () => void;
}) {
  const { csrfToken, user } = useAuth();
  // The install's owner (TRE-48). Read here rather than threaded down from the
  // manager: it is a property of who is signed in, not of which host is open.
  const owner = user?.role === "OWNER";
  const [failure, setFailure] = useState<string | null>(null);
  const [probe, setProbe] = useState<HostProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [typedName, setTypedName] = useState("");

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<HostFormValues>({
    // A new SSH host must arrive with a credential; an edit keeps the stored one.
    resolver: zodResolver(hostSchemaFor({ requireCredential: host === null, owner })),
    mode: "onSubmit",
    defaultValues: defaultsFor(host, localTaken, owner),
  });

  const transport = watch("transport");
  const roots = watch("roots");
  const homePath = watch("homePath");
  const colour = watch("colour");

  /**
   * A pin is (algorithm, fingerprint). Comparing the hashes alone would call a
   * host "changed" the moment it negotiated ed25519 where RSA was pinned, and
   * would call it "unchanged" if the same hash were pinned for another
   * algorithm — so both sides of the comparison are looked up by algorithm.
   */
  const probedAlgorithm = probe?.fingerprintAlgorithm ?? null;
  const pinnedForProbed = probedAlgorithm
    ? (host?.fingerprints.find((entry) => entry.algorithm === probedAlgorithm)?.fingerprint ?? null)
    : null;
  const storedFingerprint = host?.fingerprints[0]?.fingerprint ?? null;
  const fingerprint = probe?.fingerprint ?? storedFingerprint;

  /**
   * The server's verdict, not ours. It ran the comparison inside the handshake
   * and decided whether to continue; re-deriving it here from fingerprint
   * strings would be a second, weaker copy of the check that can disagree with
   * the one actually guarding anything.
   */
  const fingerprintMismatch = probe?.hostKeyMismatch === true;

  /**
   * Which pin the panel is describing, and whether anyone ever checked it.
   * `verifiedAt` null means it was taken on first sight and compared against
   * nothing — a real state, and one the screen should not render identically
   * to a fingerprint the user read off the host.
   */
  const shownAlgorithm = probedAlgorithm ?? host?.fingerprints[0]?.algorithm ?? null;
  const shownVerified = host?.fingerprints.find((entry) => entry.algorithm === shownAlgorithm)?.verified ?? null;

  const acceptOfferedKey = async () => {
    if (!host || !probe?.fingerprint || !probedAlgorithm) return;
    setFailure(null);
    setAccepting(true);
    try {
      await acceptHostKey(host.id, { algorithm: probedAlgorithm, fingerprint: probe.fingerprint }, csrfToken);
      // Re-read rather than patching local state: the server owns what is
      // pinned, and this screen must show what it would actually connect to.
      const fresh = (await fetchHosts()).find((entry) => entry.id === host.id);
      if (fresh) onSaved(fresh);
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "Could not accept the host key.");
    } finally {
      setAccepting(false);
    }
  };

  const runTest = async () => {
    setFailure(null);
    setProbing(true);
    setProbe(null);
    try {
      const values = watch();
      if (!values.credentialSecret) {
        setFailure(`Paste the ${CREDENTIAL_LABELS[values.credentialKind]} to test with — it is not stored yet.`);
        return;
      }
      setProbe(
        await testHost(
          {
            // So the probe holds a saved host to its pins and refuses before
            // sending the credential, rather than comparing afterwards.
            hostId: host?.id,
            address: values.address,
            port: Number(values.port),
            username: values.username,
            credentialKind: values.credentialKind,
            credentialSecret: values.credentialSecret,
          },
          csrfToken,
        ),
      );
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "The API could not be reached.");
    } finally {
      setProbing(false);
    }
  };

  const onSubmit = async (values: HostFormValues) => {
    setFailure(null);
    try {
      const payload = payloadFor(values, host, probe);
      const saved = host ? await updateHost(host.id, payload, csrfToken) : await createHost(payload, csrfToken);
      onSaved(saved);
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "The API could not be reached.");
    }
  };

  const remove = async () => {
    setFailure(null);
    if (!host) return;
    try {
      await deleteHost(host.id, csrfToken);
      onDeleted(host);
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "The API could not be reached.");
    }
  };

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="flex min-h-0 flex-1 flex-col"
      noValidate
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        <Field
          label="name"
          htmlFor="host-label"
          error={errors.label?.message}
        >
          <TextInput
            id="host-label"
            autoFocus
            placeholder="web server"
            invalid={Boolean(errors.label)}
            {...register("label")}
          />
        </Field>

        <div className="flex gap-3">
          <div className="flex-1">
            <Field label="transport">
              <Segmented
                label="Transport"
                value={transport}
                // The API refuses to change what kind of host a host is: a
                // LOCAL row's whole identity is the machine the API runs on.
                disabled={host !== null}
                onChange={(value) => setValue("transport", value)}
                options={[
                  {
                    value: "LOCAL",
                    label: "local",
                    disabled: localTaken,
                    hint: localTaken ? "This account already has a local host" : "The machine the API runs on",
                  },
                  { value: "SSH", label: "ssh" },
                ]}
              />
            </Field>
          </div>

          <Field label="colour">
            <div className="flex h-6 items-center gap-1">
              {HOST_COLOURS.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  aria-label={`Colour ${swatch}`}
                  aria-pressed={colour === swatch}
                  onClick={() => setValue("colour", swatch)}
                  style={{ backgroundColor: swatch }}
                  className={`size-4 rounded-xs ${colour === swatch ? "ring-ink ring-1 ring-offset-1 ring-offset-transparent" : "opacity-60 hover:opacity-100"}`}
                />
              ))}
            </div>
          </Field>
        </div>

        {transport === "SSH" && (
          <>
            <div className="flex gap-2">
              <div className="flex-1">
                <Field
                  label="address"
                  htmlFor="host-address"
                  error={errors.address?.message}
                >
                  <TextInput
                    id="host-address"
                    placeholder="host.example.com"
                    spellCheck={false}
                    autoComplete="off"
                    invalid={Boolean(errors.address)}
                    {...register("address")}
                  />
                </Field>
              </div>
              <div className="w-16">
                <Field
                  label="port"
                  htmlFor="host-port"
                  error={errors.port?.message}
                >
                  <TextInput
                    id="host-port"
                    inputMode="numeric"
                    invalid={Boolean(errors.port)}
                    {...register("port")}
                  />
                </Field>
              </div>
              <div className="flex-1">
                <Field
                  label="username"
                  htmlFor="host-username"
                  error={errors.username?.message}
                >
                  <TextInput
                    id="host-username"
                    spellCheck={false}
                    autoComplete="off"
                    invalid={Boolean(errors.username)}
                    {...register("username")}
                  />
                </Field>
              </div>
            </div>

            <Field
              label="credential"
              hint={
                host?.hasCredential
                  ? `A ${CREDENTIAL_LABELS[host.credentialKind ?? "PRIVATE_KEY"]} is stored. Leave blank to keep it.`
                  : "Sent once, encrypted at rest, and never readable again."
              }
              error={errors.credentialSecret?.message}
            >
              <div className="flex flex-col gap-1.5">
                <Segmented
                  label="Credential kind"
                  value={watch("credentialKind")}
                  onChange={(value) => setValue("credentialKind", value)}
                  options={[
                    { value: "PRIVATE_KEY", label: "key" },
                    { value: "PASSWORD", label: "password" },
                    { value: "AGENT", label: "agent" },
                  ]}
                />
                <textarea
                  {...register("credentialSecret")}
                  rows={watch("credentialKind") === "PRIVATE_KEY" ? 4 : 1}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={
                    watch("credentialKind") === "PRIVATE_KEY"
                      ? "-----BEGIN OPENSSH PRIVATE KEY-----"
                      : watch("credentialKind") === "AGENT"
                        ? "/run/user/1000/keyring/ssh"
                        : ""
                  }
                  className="bg-chrome border-line-strong text-ink-soft placeholder:text-ink-faint focus:border-accent-soft caret-brand w-full resize-none rounded-xs border px-2 py-1 font-mono text-xs outline-none"
                />
              </div>
            </Field>

            <ProbePanel
              probe={probe}
              probing={probing}
              fingerprint={fingerprint}
              pinnedFingerprint={probe?.pinnedFingerprint ?? pinnedForProbed}
              fingerprintMismatch={fingerprintMismatch}
              canAccept={host != null && probe?.fingerprint != null && probedAlgorithm != null}
              algorithm={shownAlgorithm}
              verified={shownVerified}
              accepting={accepting}
              onAcceptKey={acceptOfferedKey}
              onTest={runTest}
              onUseHome={(dir) => setValue("homePath", dir)}
            />
          </>
        )}

        <Field
          label="home"
          htmlFor="host-home"
          hint={owner ? "Where a pane opens." : "Where a pane opens. It must sit inside a root."}
          error={errors.homePath?.message}
        >
          <TextInput
            id="host-home"
            placeholder="/srv"
            spellCheck={false}
            autoComplete="off"
            invalid={Boolean(errors.homePath)}
            {...register("homePath")}
          />
        </Field>

        <RootsEditor
          roots={roots}
          homePath={homePath}
          enforced={!owner}
          error={errors.roots?.message ?? errors.roots?.root?.message}
          onChange={(next) => setValue("roots", next)}
        />
      </div>

      <footer className="border-line bg-chrome flex flex-none flex-col gap-2 border-t p-3">
        {failure && <p className="text-danger-soft font-mono text-2xs">{failure}</p>}

        {confirmDelete && host ? (
          <div className="flex flex-col gap-1.5">
            <p className="text-ink-muted font-mono text-2xs">
              Deleting {host.label} also removes its roots, its stored credential, its pinned keys and its bookmarks.
              Type the name to confirm.
            </p>
            <div className="flex items-center gap-2">
              <TextInput
                value={typedName}
                onChange={(event) => setTypedName(event.target.value)}
                placeholder={host.label}
                aria-label="Type the host name to confirm deletion"
                autoComplete="off"
              />
              <Button
                type="button"
                tone="danger"
                disabled={typedName !== host.label}
                onClick={remove}
              >
                delete
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setConfirmDelete(false);
                  setTypedName("");
                }}
              >
                keep
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button
              type="submit"
              tone="primary"
              disabled={isSubmitting}
            >
              {isSubmitting ? "saving…" : host ? "save" : "add host"}
            </Button>
            <Button
              type="button"
              onClick={onCancel}
            >
              cancel
            </Button>
            <div className="flex-1" />
            {host && (
              <Button
                type="button"
                tone="danger"
                onClick={() => setConfirmDelete(true)}
              >
                delete
              </Button>
            )}
          </div>
        )}
      </footer>
    </form>
  );
}

/**
 * What the probe came back with (TRE-43 §4).
 *
 * The fingerprint is shown whether or not authentication succeeded — it is
 * captured during the handshake, and seeing it is the point: pinning only
 * means something if a person looked at the value once (TRE-10).
 */
function ProbePanel({
  probe,
  probing,
  fingerprint,
  pinnedFingerprint,
  fingerprintMismatch,
  algorithm,
  verified,
  canAccept,
  accepting,
  onAcceptKey,
  onTest,
  onUseHome,
}: {
  probe: HostProbeResult | null;
  probing: boolean;
  fingerprint: string | null;
  pinnedFingerprint: string | null;
  fingerprintMismatch: boolean;
  algorithm: string | null;
  verified: boolean | null;
  canAccept: boolean;
  accepting: boolean;
  onAcceptKey: () => void;
  onTest: () => void;
  onUseHome: (dir: string) => void;
}) {
  return (
    <div className="border-line-strong flex flex-col gap-1.5 rounded-xs border p-2">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          onClick={onTest}
          disabled={probing}
        >
          {probing ? "connecting…" : "test connection"}
        </Button>
        {probe && (
          <span
            className={`font-mono text-2xs ${probe.authenticated ? "text-success" : probe.reachable ? "text-warning" : "text-danger-soft"}`}
          >
            {probe.authenticated ? "authenticated" : probe.reachable ? "reachable, auth refused" : "unreachable"}
          </span>
        )}
      </div>

      {probe && <p className="text-ink-muted font-mono text-2xs break-words">{probe.detail}</p>}

      {fingerprint && !fingerprintMismatch && (
        <div className="flex flex-col gap-0.5">
          <span className="text-ink-faint font-mono text-3xs tracking-label">
            HOST KEY{algorithm ? ` · ${algorithm}` : ""}
          </span>
          <span className="text-ink-soft font-mono text-2xs break-all">{fingerprint}</span>
          {verified === false && (
            <span className="text-warning font-mono text-2xs">
              Taken on first sight and never checked against the host.
            </span>
          )}
          <span className="text-ink-muted font-mono text-2xs">
            Compare it against <code>ssh-keygen -lf {keyFileFor(probe?.fingerprintAlgorithm)}</code> on the host itself.
            Pinning only means something if someone read it once.
          </span>
        </div>
      )}

      {fingerprintMismatch && (
        <div className="border-danger-soft flex flex-col gap-1 rounded-xs border p-2">
          <span className="text-danger-soft font-mono text-3xs tracking-label">HOST KEY DOES NOT MATCH</span>

          <div className="flex flex-col gap-0.5">
            <span className="text-ink-faint font-mono text-3xs tracking-label">PINNED</span>
            <span className="text-ink-soft font-mono text-2xs break-all">
              {pinnedFingerprint ?? "— (this algorithm was never pinned)"}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-ink-faint font-mono text-3xs tracking-label">OFFERED NOW</span>
            <span className="text-danger-soft font-mono text-2xs break-all">{probe?.fingerprint}</span>
          </div>

          <p className="text-ink-muted font-mono text-2xs">
            The connection was refused during key exchange, before any credential was offered, so nothing was sent to
            whatever answered. Either the host was rebuilt, or you are not talking to the machine you think you are.
            Check the fingerprint on the host itself before accepting — not over the connection that is failing.
          </p>

          {canAccept && (
            <Button
              type="button"
              onClick={onAcceptKey}
              disabled={accepting}
            >
              {accepting ? "accepting…" : "accept the offered key"}
            </Button>
          )}
        </div>
      )}

      {probe?.homeDir && (
        <button
          type="button"
          onClick={() => onUseHome(probe.homeDir as string)}
          className="text-ink-label self-start font-mono text-2xs hover:underline"
        >
          use {probe.homeDir} as the home
        </button>
      )}
    </div>
  );
}

function defaultsFor(host: HostView | null, localTaken: boolean, owner: boolean): HostFormValues {
  if (host) {
    return {
      label: host.label,
      transport: host.transport,
      colour: host.colour,
      homePath: host.homePath,
      // A host with no roots is a state only an owner can save, and only their
      // form can show. Standing one in for anyone else keeps the editor from
      // rendering a list the schema would refuse; doing it for an owner would
      // put a root back on the next save that they had just removed.
      roots:
        host.roots.length > 0 || owner
          ? host.roots.map((root) => ({ ...root }))
          : [{ path: host.homePath, access: "WRITE" }],
      address: host.address ?? "",
      port: String(host.port),
      username: host.username ?? "",
      credentialKind: host.credentialKind ?? "PRIVATE_KEY",
      // Never pre-filled: there is nothing to pre-fill it with, and a row of
      // dots would suggest otherwise.
      credentialSecret: "",
    };
  }

  return {
    label: "",
    // A second local host is impossible, so a fresh form offers what can work.
    transport: localTaken ? "SSH" : "LOCAL",
    colour: HOST_COLOURS[0],
    homePath: "/srv",
    roots: [{ path: "/srv", access: "WRITE" }],
    address: "",
    port: "22",
    username: "",
    credentialKind: "PRIVATE_KEY",
    credentialSecret: "",
  };
}

/**
 * The wire payload. Paths are cleaned here so `/srv/` and `/srv` are the same
 * root, and the credential and transport are only sent when they mean
 * something — a PATCH that names `transport` would be refused, and one that
 * names an empty secret would ask the server to store nothing.
 */
/**
 * Where OpenSSH keeps the host key for a given algorithm, so "compare it
 * against" names the file that actually holds the key being shown. Naming the
 * ed25519 file for an RSA host sends the reader to a fingerprint that cannot
 * match, which teaches them to ignore a mismatch.
 */
function keyFileFor(algorithm: string | null | undefined): string {
  if (algorithm?.includes("ed25519")) return "/etc/ssh/ssh_host_ed25519_key.pub";
  if (algorithm?.includes("rsa")) return "/etc/ssh/ssh_host_rsa_key.pub";
  if (algorithm?.includes("ecdsa")) return "/etc/ssh/ssh_host_ecdsa_key.pub";
  return "/etc/ssh/ssh_host_*_key.pub";
}

function payloadFor(values: HostFormValues, host: HostView | null, probe: HostProbeResult | null): HostInput {
  const payload: HostInput = {
    label: values.label,
    colour: values.colour,
    homePath: cleanPath(values.homePath),
    roots: values.roots.map((root) => ({ path: cleanPath(root.path), access: root.access })),
  };

  if (!host) payload.transport = values.transport;

  if (values.transport === "SSH") {
    payload.address = values.address;
    payload.port = Number(values.port);
    payload.username = values.username;
    if (values.credentialSecret) {
      payload.credentialKind = values.credentialKind;
      payload.credentialSecret = values.credentialSecret;
    }
    // A pin travels with a save only when the host has none at all — creating,
    // or an SSH host that was never probed. Replacing one is POST
    // :id/known-keys, so a key change can never ride along on the save that
    // renamed the host (TRE-10 §3). The algorithm comes off the wire; hardcoding
    // it wrote pins that could never match what the host offers.
    if (probe?.fingerprint && probe.fingerprintAlgorithm && !host?.fingerprints.length) {
      payload.fingerprint = probe.fingerprint;
      payload.fingerprintAlgorithm = probe.fingerprintAlgorithm;
    }
  }

  return payload;
}
