"use client";

import { useAuth } from "@auth/context/AuthContext";
import { Button, Field, Segmented, TextInput } from "@components/hosts/field";
import { RootsEditor } from "@components/hosts/roots-editor";
import { zodResolver } from "@hookform/resolvers/zod";
import { ApiError } from "@lib/api/client";
import { createHost, deleteHost, testHost, updateHost } from "@lib/api/hosts";
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
  const { csrfToken } = useAuth();
  const [failure, setFailure] = useState<string | null>(null);
  const [probe, setProbe] = useState<HostProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [typedName, setTypedName] = useState("");

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<HostFormValues>({
    // A new SSH host must arrive with a credential; an edit keeps the stored one.
    resolver: zodResolver(hostSchemaFor(host === null)),
    mode: "onSubmit",
    defaultValues: defaultsFor(host, localTaken),
  });

  const transport = watch("transport");
  const roots = watch("roots");
  const homePath = watch("homePath");
  const colour = watch("colour");

  /** The pin we would save: whatever the last probe saw, else what is stored. */
  const storedFingerprint = host?.fingerprints[0]?.fingerprint ?? null;
  const fingerprint = probe?.fingerprint ?? storedFingerprint;
  const fingerprintChanged =
    probe?.fingerprint != null && storedFingerprint != null && probe.fingerprint !== storedFingerprint;

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
      const payload = payloadFor(values, host, fingerprint);
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
                    title: localTaken ? "This account already has a local host" : "The machine the API runs on",
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
              fingerprintChanged={fingerprintChanged}
              onTest={runTest}
              onUseHome={(dir) => setValue("homePath", dir)}
            />
          </>
        )}

        <Field
          label="home"
          htmlFor="host-home"
          hint="Where a pane opens. It must sit inside a root."
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
  fingerprintChanged,
  onTest,
  onUseHome,
}: {
  probe: HostProbeResult | null;
  probing: boolean;
  fingerprint: string | null;
  fingerprintChanged: boolean;
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

      {fingerprint && (
        <div className="flex flex-col gap-0.5">
          <span className="text-ink-faint font-mono text-3xs tracking-label">HOST KEY</span>
          <span className={`font-mono text-2xs break-all ${fingerprintChanged ? "text-danger-soft" : "text-ink-soft"}`}>
            {fingerprint}
          </span>
          {fingerprintChanged && (
            <span className="text-danger-soft font-mono text-2xs">
              This is not the key that was pinned. Either the host was rebuilt, or you are not talking to the machine
              you think you are. Saving replaces the pin.
            </span>
          )}
        </div>
      )}

      {probe?.homeDir && (
        <button
          type="button"
          onClick={() => onUseHome(probe.homeDir as string)}
          className="text-ink-link self-start font-mono text-2xs hover:underline"
        >
          use {probe.homeDir} as the home
        </button>
      )}
    </div>
  );
}

function defaultsFor(host: HostView | null, localTaken: boolean): HostFormValues {
  if (host) {
    return {
      label: host.label,
      transport: host.transport,
      colour: host.colour,
      homePath: host.homePath,
      roots:
        host.roots.length > 0 ? host.roots.map((root) => ({ ...root })) : [{ path: host.homePath, access: "WRITE" }],
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
function payloadFor(values: HostFormValues, host: HostView | null, fingerprint: string | null): HostInput {
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
    // Only pinned once it has been seen. Sending back the value the server
    // already holds would re-stamp `verifiedAt` on every unrelated save.
    if (fingerprint && fingerprint !== host?.fingerprints[0]?.fingerprint) {
      payload.fingerprint = fingerprint;
      payload.fingerprintAlgorithm = "ssh";
    }
  }

  return payload;
}
