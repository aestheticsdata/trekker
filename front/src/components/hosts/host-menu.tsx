"use client";

import { ContextMenu } from "@components/ui/context-menu";

import type { MenuRow } from "@components/shell/actions";
import type { Point } from "@helpers/menu";
import type { HostView } from "@lib/api/hosts";

/**
 * What a sidebar server row's right-click offers (TRE-87).
 *
 * One row, and that is the point of it: the row's click binds the host to the
 * active pane, which is its job, and on a one-host install that click changes
 * nothing visible — so the row needed a second thing it could do, and the thing
 * people come to a list called SERVERS for is to change one.
 *
 * `ContextMenu` for the reason `ViewMenu` uses it: one panel, one keyboard.
 */

/** The ids this menu dispatches. Local to the file: no registry has these. */
const EDIT = "host.edit";

interface HostMenuProps {
  host: HostView;
  point: Point;
  onEdit: () => void;
  onClose: () => void;
}

export function HostMenu({ host, point, onEdit, onClose }: HostMenuProps) {
  const rows: readonly MenuRow[] = [{ id: EDIT, label: "Edit host…" }];

  return (
    <ContextMenu
      point={point}
      label={host.label}
      rows={rows}
      onClose={onClose}
      onChoose={(id) => {
        onClose();
        if (id === EDIT) onEdit();
      }}
    />
  );
}
