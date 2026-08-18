"use client";

import { useAuth } from "@auth/context/AuthContext";
import { Overlay } from "@components/ui/overlay";
import { useToast } from "@components/ui/toast";
import { ELEVATE_FILL, ELEVATE_INK, SUDO_INK, SUDO_SURFACE } from "@helpers/sudo";
import { ApiError } from "@lib/api/client";
import { fetchSudoRequirement, formatWindow, openSudo } from "@lib/api/sudo";
import { QUERY_KEYS } from "@lib/query/keys";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { HostView } from "@lib/api/hosts";
import type { SudoRequirement } from "@lib/api/sudo";
import type { ReactNode } from "react";

/**
 * Opening a sudo window on one host (TRE-29).
 *
 * The modal asks the host what it wants *before* it draws anything, and that
 * order is the whole design. Most cloud images ship their default account with
 * `NOPASSWD: ALL`; `sudo` on such a host never reads what it is sent, so a
 * password field there would accept the wrong password, a blank one, anything
 * at all, and then report success. The first implementation of this ticket had
 * exactly that bug. So `GET :id/sudo` runs first and this renders one of four
 * things: a password field, a confirm button, or one of two refusals nothing
 * typed here can answer.
 *
 * The password goes up once and is never held on this side — not in a ref, not
 * in a query cache, not in the toast that follows. The field's state dies with
 * the panel, which is what unmounting on close is for.
 */

export function SudoModal({ host, onClose }: { host: HostView; onClose: () => void }) {
  return (
    <Overlay
      label={`Elevate with sudo on ${host.label}`}
      onClosed={onClose}
      panelClassName="bg-app border-warning flex w-full max-w-[30rem] flex-col overflow-hidden rounded-sm border shadow-2xl"
    >
      {(close) => (
        <SudoPanel
          host={host}
          close={close}
        />
      )}
    </Overlay>
  );
}

function SudoPanel({ host, close }: { host: HostView; close: () => void }) {
  const { csrfToken } = useAuth();
  const queryClient = useQueryClient();
  const { push } = useToast();

  const [password, setPassword] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  /**
   * Asked once, when the modal opens.
   *
   * Not refetched on focus, and not retried: it runs `sudo -n id -u` on the
   * host, and a sudoers file does not change while a dialog is open. Retrying
   * would also spend the rate limit's budget on a question nobody asked twice.
   */
  const requirement = useQuery({
    queryKey: [QUERY_KEYS.SUDO_REQUIREMENT, host.id],
    queryFn: () => fetchSudoRequirement(host.id),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    throwOnError: false,
    retry: false,
  });

  const needs = requirement.data?.needs ?? null;

  const elevate = useMutation({
    // Null rather than an empty string on a host that wants none: the API
    // refuses a present-but-blank password, and rightly — an empty string is a
    // guess, not an absence.
    mutationFn: () => openSudo(host.id, needs === "password" ? password : null, csrfToken),
    throwOnError: false,
    onSuccess: (window) => {
      // The badge and every `#` prompt in the app read the remaining time off
      // the hosts list, so this is what lights them.
      void queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.HOSTS] });
      push({
        tone: "warning",
        message: `sudo open on ${window.hostLabel}`,
        detail: `${formatWindow(window.remainingMs)} left · prompts show #`,
      });
      close();
    },
    onError: (error) => {
      setFailure(error instanceof ApiError ? error.message : "The request could not be sent.");
      // Cleared rather than kept for a second try. A refused password is the
      // one string in this app most likely to be a near-miss of a different
      // secret, and leaving it in a focused field invites sending it again.
      setPassword("");
    },
  });

  // The two configuration answers have no form at all — there is nothing to
  // fill in and nothing to press.
  const answerable = needs === "none" || needs === "password";
  const armed = answerable && (needs === "none" || password.length > 0) && !elevate.isPending;

  return (
    <>
      <header className={`${SUDO_SURFACE} border-warning flex h-topbar flex-none items-center gap-2 border-b px-3`}>
        <span className={`${SUDO_INK} font-mono text-xs font-semibold tracking-label`}>sudo</span>
        <span className="text-ink-muted min-w-0 truncate font-mono text-cmd">{host.label}</span>
        {host.username && <span className="text-ink-faint flex-none font-mono text-2xs">{host.username}</span>}
      </header>

      <div className="flex flex-col gap-2.5 px-3.5 py-3">
        {requirement.isPending && <p className="text-ink-faint font-mono text-xs">asking the host…</p>}

        {requirement.error !== null && (
          <Notice tone="bad">
            {requirement.error instanceof ApiError
              ? requirement.error.message
              : `${host.label} could not be asked whether sudo would work.`}
          </Notice>
        )}

        {needs !== null && <Explanation needs={needs} />}

        {needs === "password" && (
          <label className="flex flex-col gap-1">
            <span className="text-ink-faint font-mono text-2xs tracking-label">
              {host.username ? `password for ${host.username}` : "account password"}
            </span>
            <input
              type="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setFailure(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && armed) elevate.mutate();
              }}
              // Autofocused, unlike the delete modal's token field, and for the
              // opposite reason: that one is asking the reader to stop, this one
              // is asking them to type a password they already decided to give.
              // biome-ignore lint/a11y/noAutofocus: the field is the only work in this dialog
              autoFocus
              autoComplete="off"
              spellCheck={false}
              aria-label={host.username ? `Password for ${host.username}` : "Account password"}
              className="bg-chrome border-line-strong text-ink focus:border-warning w-full border px-2.25 py-1.75 font-mono text-name/none"
            />
          </label>
        )}

        {/* Shown once the answer is in, since the number comes from the server
            and this install may not be running the default fifteen. */}
        {answerable && requirement.data && (
          <p className="text-ink-faint font-mono text-2xs/[1.6]">
            The window lasts {formatWindow(requirement.data.windowMs)} and covers this host only, in this browser
            session only. Close it early from the badge at any time.
          </p>
        )}

        {failure !== null && <Notice tone="bad">{failure}</Notice>}
      </div>

      <footer className="bg-chrome flex h-11 flex-none items-center gap-2 px-3.5">
        <div className="flex-1" />
        <button
          type="button"
          onClick={close}
          className="border-line-strong text-ink-soft border px-3.5 py-1.75 font-mono text-xs/none"
        >
          cancel
        </button>
        {answerable && (
          <button
            type="button"
            onClick={() => elevate.mutate()}
            disabled={!armed}
            // Amber rather than the accent, and amber while inert: this is the
            // button that makes the next `rm` run as root, and it should never
            // look like the save on a settings form.
            className={`${ELEVATE_FILL} ${ELEVATE_INK} disabled:bg-line disabled:text-ink-faint px-3.5 py-1.75 font-mono text-xs/none font-medium disabled:cursor-not-allowed`}
          >
            {elevate.isPending ? "asking sudo…" : "elevate"}
          </button>
        )}
      </footer>
    </>
  );
}

/**
 * What this host said, in the reader's terms.
 *
 * The `none` case says out loud that no password will be asked for. It would be
 * easy to leave that unmentioned and let the confirm button imply it, but the
 * absence of a prompt is precisely the thing a careful person would otherwise
 * read as a bug in Trekker — and it is not one, it is the host's sudoers file.
 */
function Explanation({ needs }: { needs: SudoRequirement }) {
  if (needs === "password") {
    return (
      <p className="text-ink-soft font-mono text-cmd/[1.6]">
        This host asks for the account's own login password before it will run sudo. It is sent once, held in the API's
        memory for the length of the window, and never written down — not beside the SSH credential, not to disk, not to
        the audit log.
      </p>
    );
  }

  if (needs === "none") {
    return (
      <>
        <p className="text-ink-soft font-mono text-cmd/[1.6]">
          This account may run sudo here without a password, so there is nothing to type. Confirming is the whole check.
        </p>
        {/* Not Trekker's doing, and worth saying rather than hiding: on a
            NOPASSWD host the stored SSH credential is already sufficient for
            root, so this window is a deliberate gesture rather than a barrier.
            Only a change on the server makes it one. */}
        <Notice tone="warn">
          Because sudo asks this account for nothing, the credential Trekker already holds for this host is enough to
          become root on it. This window records the intent; it cannot add a check the machine does not make.
        </Notice>
      </>
    );
  }

  if (needs === "not-a-sudoer") {
    return (
      <Notice tone="bad">
        This account is not permitted to run sudo on this host. An administrator has to grant it there before Trekker
        can use it — nothing typed here will change that.
      </Notice>
    );
  }

  return (
    <Notice tone="bad">
      There is no sudo on this host, so there is nothing for Trekker to elevate with. Root-owned paths stay read-only.
    </Notice>
  );
}

function Notice({ tone, children }: { tone: "warn" | "bad"; children: ReactNode }) {
  return (
    <p className={`font-mono text-2xs/[1.6] ${tone === "bad" ? "text-danger-soft" : "text-warning"}`}>{children}</p>
  );
}
