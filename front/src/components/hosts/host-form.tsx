"use client";

import { useAuth } from "@auth/context/AuthContext";
import { Button, Field, Segmented, TextInput } from "@components/hosts/field";
import { RootsEditor } from "@components/hosts/roots-editor";
import { zodResolver } from "@hookform/resolvers/zod";
import { interpolate } from "@i18n/interpolate";
import useTranslations from "@i18n/useTranslations";
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
  const t = useTranslations("hosts");
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
      setFailure(error instanceof ApiError ? error.message : t.form.failures.acceptKey);
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
        setFailure(interpolate(t.form.failures.pasteSecret, { kind: CREDENTIAL_LABELS[values.credentialKind] }));
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
      setFailure(error instanceof ApiError ? error.message : t.form.failures.unreachable);
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
      setFailure(error instanceof ApiError ? error.message : t.form.failures.unreachable);
    }
  };

  const remove = async () => {
    setFailure(null);
    if (!host) return;
    try {
      await deleteHost(host.id, csrfToken);
      onDeleted(host);
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : t.form.failures.unreachable);
    }
  };

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      data-testid="host-form"
      className="flex min-h-0 flex-1 flex-col"
      noValidate
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        <Field
          label={t.form.labels.name}
          htmlFor="host-label"
          error={errors.label?.message}
        >
          <TextInput
            id="host-label"
            autoFocus
            placeholder={t.form.placeholders.name}
            invalid={Boolean(errors.label)}
            data-testid="host-form-label"
            {...register("label")}
          />
        </Field>

        <div className="flex gap-3">
          <div className="flex-1">
            <Field label={t.form.labels.transport}>
              <Segmented
                label={t.form.transport.label}
                value={transport}
                // The API refuses to change what kind of host a host is: a
                // LOCAL row's whole identity is the machine the API runs on.
                disabled={host !== null}
                onChange={(value) => setValue("transport", value)}
                options={[
                  {
                    value: "LOCAL",
                    label: t.form.transport.local,
                    disabled: localTaken,
                    hint: localTaken ? t.form.transport.localTaken : t.form.transport.localHint,
                  },
                  { value: "SSH", label: t.form.transport.ssh },
                ]}
              />
            </Field>
          </div>

          <Field label={t.form.labels.colour}>
            <div className="flex h-6 items-center gap-1">
              {HOST_COLOURS.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  aria-label={interpolate(t.form.colourSwatch, { swatch })}
                  aria-pressed={colour === swatch}
                  // The hex is the value the host row stores in `colour`, not a
                  // tone describing state — so it is the member's name here.
                  data-testid="host-form-colour"
                  data-swatch={swatch}
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
                  label={t.form.labels.address}
                  htmlFor="host-address"
                  error={errors.address?.message}
                >
                  <TextInput
                    id="host-address"
                    placeholder={t.form.placeholders.address}
                    spellCheck={false}
                    autoComplete="off"
                    invalid={Boolean(errors.address)}
                    data-testid="host-form-address"
                    {...register("address")}
                  />
                </Field>
              </div>
              <div className="w-16">
                <Field
                  label={t.form.labels.port}
                  htmlFor="host-port"
                  error={errors.port?.message}
                >
                  <TextInput
                    id="host-port"
                    inputMode="numeric"
                    invalid={Boolean(errors.port)}
                    data-testid="host-form-port"
                    {...register("port")}
                  />
                </Field>
              </div>
              <div className="flex-1">
                <Field
                  label={t.form.labels.username}
                  htmlFor="host-username"
                  error={errors.username?.message}
                >
                  <TextInput
                    id="host-username"
                    spellCheck={false}
                    autoComplete="off"
                    invalid={Boolean(errors.username)}
                    data-testid="host-form-username"
                    {...register("username")}
                  />
                </Field>
              </div>
            </div>

            <Field
              label={t.form.labels.credential}
              hint={
                host?.hasCredential
                  ? interpolate(t.form.credential.stored, {
                      kind: CREDENTIAL_LABELS[host.credentialKind ?? "PRIVATE_KEY"],
                    })
                  : t.form.credential.fresh
              }
              error={errors.credentialSecret?.message}
            >
              <div className="flex flex-col gap-1.5">
                <Segmented
                  label={t.form.credential.kindLabel}
                  value={watch("credentialKind")}
                  onChange={(value) => setValue("credentialKind", value)}
                  options={[
                    { value: "PRIVATE_KEY", label: t.form.credential.key },
                    { value: "PASSWORD", label: t.form.credential.password },
                    { value: "AGENT", label: t.form.credential.agent },
                  ]}
                />
                <textarea
                  {...register("credentialSecret")}
                  rows={watch("credentialKind") === "PRIVATE_KEY" ? 4 : 1}
                  spellCheck={false}
                  autoComplete="off"
                  data-testid="host-form-secret"
                  placeholder={
                    watch("credentialKind") === "PRIVATE_KEY"
                      ? t.form.placeholders.privateKey
                      : watch("credentialKind") === "AGENT"
                        ? t.form.placeholders.agentSocket
                        : ""
                  }
                  className="bg-chrome border-line-strong text-ink-soft placeholder:text-ink-faint focus:border-accent-soft caret-brand w-full resize-none rounded-xs border px-2 py-1 font-mono text-xs"
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
          label={t.form.labels.home}
          htmlFor="host-home"
          hint={owner ? t.form.homeHint.owner : t.form.homeHint.member}
          error={errors.homePath?.message}
        >
          <TextInput
            id="host-home"
            placeholder={t.form.placeholders.home}
            spellCheck={false}
            autoComplete="off"
            invalid={Boolean(errors.homePath)}
            data-testid="host-form-home"
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
              {interpolate(t.form.deletion.warning, { label: host.label })}
            </p>
            <div className="flex items-center gap-2">
              <TextInput
                value={typedName}
                onChange={(event) => setTypedName(event.target.value)}
                placeholder={host.label}
                aria-label={t.form.deletion.confirmLabel}
                autoComplete="off"
                data-testid="host-form-delete-name"
              />
              {/* ⚠️ Two buttons in this footer read `delete`: this one removes
                  the host, the one below only arms this row. Never mounted
                  together, but text alone cannot tell them apart — and this one
                  sits one gap from `keep`. */}
              <Button
                type="button"
                tone="danger"
                disabled={typedName !== host.label}
                onClick={remove}
                data-testid="host-form-delete-confirm"
              >
                {t.form.deletion.delete}
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setConfirmDelete(false);
                  setTypedName("");
                }}
                data-testid="host-form-delete-keep"
              >
                {t.form.deletion.keep}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button
              type="submit"
              tone="primary"
              disabled={isSubmitting}
              // `save`, `add host` or `saving…` by state; the name holds still.
              data-testid="host-form-save"
            >
              {isSubmitting ? t.form.actions.saving : host ? t.form.actions.save : t.form.actions.add}
            </Button>
            <Button
              type="button"
              onClick={onCancel}
              data-testid="host-form-cancel"
            >
              {t.form.actions.cancel}
            </Button>
            <div className="flex-1" />
            {host && (
              <Button
                type="button"
                tone="danger"
                onClick={() => setConfirmDelete(true)}
                data-testid="host-form-delete"
              >
                {t.form.actions.delete}
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
  const t = useTranslations("hosts");

  return (
    <div className="border-line-strong flex flex-col gap-1.5 rounded-xs border p-2">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          onClick={onTest}
          disabled={probing}
          data-testid="host-form-test"
        >
          {probing ? t.probe.testing : t.probe.test}
        </Button>
        {probe && (
          <span
            className={`font-mono text-2xs ${probe.authenticated ? "text-success" : probe.reachable ? "text-warning" : "text-danger-soft"}`}
          >
            {probe.authenticated ? t.probe.authenticated : probe.reachable ? t.probe.authRefused : t.probe.unreachable}
          </span>
        )}
      </div>

      {probe && <p className="text-ink-muted font-mono text-2xs break-words">{probe.detail}</p>}

      {fingerprint && !fingerprintMismatch && (
        <div className="flex flex-col gap-0.5">
          <span className="text-ink-faint font-mono text-3xs tracking-label">
            {algorithm ? interpolate(t.probe.hostKeyAlgorithm, { algorithm }) : t.probe.hostKey}
          </span>
          <span className="text-ink-soft font-mono text-2xs break-all">{fingerprint}</span>
          {verified === false && <span className="text-warning font-mono text-2xs">{t.probe.unverified}</span>}
          <span className="text-ink-muted font-mono text-2xs">
            {t.probe.compare.before}{" "}
            <code>{interpolate(t.probe.compare.command, { file: keyFileFor(probe?.fingerprintAlgorithm) })}</code>{" "}
            {t.probe.compare.after}
          </span>
        </div>
      )}

      {fingerprintMismatch && (
        <div className="border-danger-soft flex flex-col gap-1 rounded-xs border p-2">
          <span className="text-danger-soft font-mono text-3xs tracking-label">{t.probe.mismatch.heading}</span>

          <div className="flex flex-col gap-0.5">
            <span className="text-ink-faint font-mono text-3xs tracking-label">{t.probe.mismatch.pinned}</span>
            <span className="text-ink-soft font-mono text-2xs break-all">
              {pinnedFingerprint ?? t.probe.mismatch.neverPinned}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-ink-faint font-mono text-3xs tracking-label">{t.probe.mismatch.offered}</span>
            <span className="text-danger-soft font-mono text-2xs break-all">{probe?.fingerprint}</span>
          </div>

          <p className="text-ink-muted font-mono text-2xs">{t.probe.mismatch.explanation}</p>

          {canAccept && (
            <Button
              type="button"
              onClick={onAcceptKey}
              disabled={accepting}
              data-testid="host-form-accept-key"
            >
              {accepting ? t.probe.mismatch.accepting : t.probe.mismatch.accept}
            </Button>
          )}
        </div>
      )}

      {probe?.homeDir && (
        <button
          type="button"
          onClick={() => onUseHome(probe.homeDir as string)}
          data-testid="host-form-use-home"
          className="text-ink-label self-start font-mono text-2xs hover:underline"
        >
          {interpolate(t.probe.useHome, { dir: probe.homeDir })}
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
