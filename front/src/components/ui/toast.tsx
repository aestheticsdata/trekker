"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";

/**
 * Toasts (TRE-14 §4): bottom right, stacked, auto-dismissing.
 *
 * The live region is the point. Every destructive action in M2 reports through
 * here, and an operator who cannot see the corner of the screen — or is not
 * looking at it — still has to learn that the delete finished.
 */

export type ToastTone = "info" | "success" | "warning" | "danger";

export interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
  /** Optional second line: the path, the count, the reason. */
  detail?: string;
  /** A button rendered under the detail line — "Undo", and nothing else yet. */
  action?: { label: string; onClick: () => void; title?: string };
}

interface ToastContextValue {
  toasts: readonly Toast[];
  push: (toast: Omit<Toast, "id">) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/** Long enough to read a path, short enough not to cover the status bar. */
const DISMISS_AFTER_MS = 6_000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const nextId = useRef(1);

  // Plain functions and a plain object: the React Compiler does the memoising,
  // so a hand-written useCallback here would only be a dependency array for a
  // reader to check.
  const dismiss = (id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  };

  const push = (toast: Omit<Toast, "id">) => {
    const id = nextId.current++;
    setToasts((current) => [...current, { ...toast, id }]);
    return id;
  };

  return (
    <ToastContext.Provider value={{ toasts, push, dismiss }}>
      {children}
      <ToastViewport />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside a ToastProvider");
  return context;
}

const TONE_CLASS: Record<ToastTone, string> = {
  info: "border-line-strong text-ink-soft",
  success: "border-success/40 text-success",
  warning: "border-warning/50 text-warning",
  danger: "border-danger-mid text-danger-soft",
};

function ToastViewport() {
  const { toasts } = useToast();

  return (
    // `polite`, not `assertive`: a finished copy should not interrupt someone
    // mid-sentence. Failures are announced the same way — the tone is carried
    // in the text, which is what a screen reader actually conveys.
    <div
      aria-live="polite"
      aria-relevant="additions"
      className="pointer-events-none fixed right-3 bottom-[calc(var(--spacing-statusbar)+0.5rem)] z-50 flex w-72 flex-col gap-1.5"
    >
      {toasts.map((toast) => (
        <ToastRow
          key={toast.id}
          toast={toast}
        />
      ))}
    </div>
  );
}

function ToastRow({ toast }: { toast: Toast }) {
  const { dismiss } = useToast();

  useEffect(() => {
    const timer = setTimeout(() => dismiss(toast.id), DISMISS_AFTER_MS);
    return () => clearTimeout(timer);
  }, [toast.id, dismiss]);

  return (
    <output
      // 2a's `tkToast`: up from below, over .18s. Slower than the panels on
      // purpose — a toast arrives unasked, in the corner, and has to catch the
      // eye of someone looking somewhere else.
      className={`bg-raised animate-toast-in pointer-events-auto flex flex-col gap-0.5 rounded-sm border px-2.5 py-1.5 shadow-lg ${TONE_CLASS[toast.tone]}`}
    >
      <span className="text-xs">{toast.message}</span>
      {toast.detail && <span className="text-ink-dim font-mono text-2xs break-all">{toast.detail}</span>}
      {toast.action && (
        <button
          type="button"
          onClick={() => {
            toast.action?.onClick();
            dismiss(toast.id);
          }}
          title={toast.action.title}
          className="text-ink hover:text-ink-muted mt-0.5 w-fit cursor-pointer font-mono text-2xs underline underline-offset-2"
        >
          {toast.action.label}
        </button>
      )}
    </output>
  );
}
