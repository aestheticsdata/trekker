"use client";

import { Button } from "@components/hosts/field";
import { HostForm } from "@components/hosts/host-form";
import { useToast } from "@components/ui/toast";
import { useEffect, useState } from "react";

import type { HostView } from "@lib/api/hosts";

/**
 * The host manager (TRE-43).
 *
 * A dialog rather than a page: choosing and editing a host is something you do
 * *to* the explorer, and losing the two panes to a settings screen to add a
 * machine is a worse trade than a panel over them. It is also the only way in
 * on a fresh install — a deployment with no hosts shows nothing but this, from
 * the pane's own empty state.
 *
 * Hosts are listed on the left and edited on the right, because the list is
 * also the picker: the pane that opened the dialog binds to whatever is chosen.
 */

type Mode = { kind: "idle" } | { kind: "edit"; host: HostView } | { kind: "create" };

export function HostManager({
  hosts,
  boundHostId,
  onPick,
  onChanged,
  onClose,
}: {
  hosts: readonly HostView[];
  /** What the pane that opened this is currently showing, if anything. */
  boundHostId: string | null;
  onPick: (host: HostView) => void;
  /** A host was created, changed or deleted — refetch and rebind as needed. */
  onChanged: (event: { host: HostView; deleted?: boolean }) => void;
  onClose: () => void;
}) {
  const { push } = useToast();
  // A deployment with no hosts has exactly one useful thing to show.
  const [mode, setMode] = useState<Mode>(() => (hosts.length === 0 ? { kind: "create" } : { kind: "idle" }));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const localTaken = hosts.some(
    (host) => host.transport === "LOCAL" && !(mode.kind === "edit" && mode.host.id === host.id),
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop is a pointer shortcut for ⎋, which the effect above already provides
    <div
      className="bg-chrome/80 fixed inset-0 z-40 flex items-center justify-center p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Hosts"
        className="bg-app border-line-strong flex h-full max-h-[36rem] w-full max-w-[46rem] overflow-hidden rounded-sm border shadow-2xl"
      >
        <div className="border-line bg-chrome flex w-52 flex-none flex-col border-r">
          <header className="border-line text-ink-muted flex h-toolbar flex-none items-center justify-between border-b px-2.5 font-mono text-2xs tracking-label">
            HOSTS
            <span className="text-ink-faint">{hosts.length}</span>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {hosts.map((host) => (
              <HostRow
                key={host.id}
                host={host}
                bound={host.id === boundHostId}
                selected={mode.kind === "edit" && mode.host.id === host.id}
                onEdit={() => setMode({ kind: "edit", host })}
                onPick={() => {
                  onPick(host);
                  onClose();
                }}
              />
            ))}
            {hosts.length === 0 && (
              <p className="text-ink-faint p-2.5 font-mono text-2xs/relaxed">
                No hosts yet. Add the machine the API runs on, or an SSH host.
              </p>
            )}
          </div>

          <div className="border-line flex-none border-t p-2">
            <Button
              type="button"
              onClick={() => setMode({ kind: "create" })}
              className="w-full justify-center"
            >
              + new host
            </Button>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="border-line text-ink-muted flex h-toolbar flex-none items-center justify-between border-b px-3 font-mono text-2xs tracking-label">
            {mode.kind === "create" ? "NEW HOST" : mode.kind === "edit" ? mode.host.slug : "SELECT A HOST"}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              title="Close (⎋)"
              className="text-ink-faint hover:text-ink px-1 font-mono text-sm"
            >
              ✕
            </button>
          </header>

          {mode.kind === "idle" ? (
            <p className="text-ink-faint flex flex-1 items-center justify-center p-6 text-center font-mono text-2xs/relaxed">
              Pick a host on the left to open it in this pane, or its name to edit it.
            </p>
          ) : (
            <HostForm
              // A fresh form per target, so switching between two hosts does not
              // carry the first one's typing into the second.
              key={mode.kind === "edit" ? mode.host.id : "new"}
              host={mode.kind === "edit" ? mode.host : null}
              localTaken={localTaken}
              onSaved={(host) => {
                onChanged({ host });
                push({ tone: "success", message: `${host.label} saved`, detail: describe(host) });
                setMode({ kind: "edit", host });
              }}
              onDeleted={(host) => {
                onChanged({ host, deleted: true });
                push({ tone: "warning", message: `${host.label} deleted` });
                setMode({ kind: "idle" });
              }}
              onCancel={() => setMode({ kind: "idle" })}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function HostRow({
  host,
  bound,
  selected,
  onEdit,
  onPick,
}: {
  host: HostView;
  bound: boolean;
  selected: boolean;
  onEdit: () => void;
  onPick: () => void;
}) {
  return (
    <div
      className={`border-line flex items-center gap-1.5 border-b px-2 py-1.5 ${selected ? "bg-raised" : "hover:bg-raised/60"}`}
    >
      <span
        aria-hidden
        className="size-1.5 flex-none rounded-full"
        style={{ backgroundColor: host.colour }}
      />
      <button
        type="button"
        onClick={onEdit}
        className="flex min-w-0 flex-1 flex-col items-start text-left"
      >
        <span className="text-ink-soft w-full truncate font-mono text-xs">{host.label}</span>
        <span className="text-ink-faint w-full truncate font-mono text-2xs">{describe(host)}</span>
      </button>
      <button
        type="button"
        onClick={onPick}
        title={bound ? "Already open in this pane" : "Open in this pane"}
        aria-label={`Open ${host.label} in this pane`}
        className={`flex-none px-1 font-mono text-2xs ${bound ? "text-accent-soft" : "text-ink-faint hover:text-ink"}`}
      >
        {bound ? "●" : "→"}
      </button>
    </div>
  );
}

function describe(host: HostView): string {
  if (host.transport === "LOCAL") return `local · ${host.homePath}`;
  return `${host.username ?? "?"}@${host.address ?? "?"}${host.port === 22 ? "" : `:${host.port}`}`;
}
