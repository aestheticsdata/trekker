"use client";

import { useCallback, useEffect, useState } from "react";

import type { ReactNode } from "react";

/**
 * The shell every dialog in this app sits in: backdrop, centring, ⎋, and the
 * two animations 2a draws for a panel arriving (`tkFade` and `tkIn`).
 *
 * It exists because of the exit. Entering is free — a mounted element can
 * animate itself — but leaving is not: React unmounts the moment the state
 * flips, and a panel that vanishes between two frames is what makes a dense UI
 * feel like it is snapping rather than moving. So closing is a two-step here:
 * the panel is told to leave, and only when its animation actually ends does
 * the caller's `onClosed` run and the tree come down. `animationend` rather
 * than a timeout, so the two can never disagree about how long it took.
 *
 * The child is a function because of the same asymmetry: a cancel button and a
 * successful save both need the animated close, not the abrupt one, so the way
 * to trigger it has to be handed down.
 */
export function Overlay({
  label,
  onClosed,
  panelClassName = "",
  children,
}: {
  /** Names the dialog for anyone not looking at it. */
  label: string;
  /** Runs once the exit animation has finished — unmount from here. */
  onClosed: () => void;
  /** The panel's own box: width, border, background. */
  panelClassName?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [leaving, setLeaving] = useState(false);
  const close = useCallback(() => setLeaving(true), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop is a pointer shortcut for ⎋, which the effect above already provides
    <div
      className={`bg-chrome/80 fixed inset-0 z-40 flex items-center justify-center p-6 ${
        leaving ? "animate-overlay-out" : "animate-overlay-in"
      }`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`${leaving ? "animate-panel-out" : "animate-panel-in"} ${panelClassName}`}
        // Guarded on the target: a panel this size holds other animated things,
        // and a shimmering skeleton inside it would otherwise close the dialog
        // the moment its own animation ended.
        onAnimationEnd={(event) => {
          if (leaving && event.target === event.currentTarget) onClosed();
        }}
      >
        {children(close)}
      </div>
    </div>
  );
}
