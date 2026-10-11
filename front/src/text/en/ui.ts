/** Shared chrome in `components/ui/`: the upload tray and the transfer queue. */
const ui = {
  uploads: {
    label: "Uploads",
    heading: "uploads",
    finished: "{count} finished",
    queued: "{count} queued, waiting on the limit",
    inFlight: "{count} in flight",
    cancelAll: "cancel all",
    clear: "clear",
    cancelRow: "Cancel {name}",
    dismissRow: "Dismiss {name}",
    noAnswer: "The server did not answer for this file.",
    alreadyThere: "already there",
    refused: "The host refused it.",
    continuing: "continuing — {size} already there",
    rateLimited: "rate limit — resuming in {seconds}s",
    connectionLost: "connection lost — continuing in {seconds}s",
    cancelled: "Cancelled.",
    cancelledWithBatch: "Cancelled with its batch.",
    incomplete: "The upload did not complete.",
    noSpace: "No room at the destination",
    limitReached: "Upload limit reached",
  },
  transfers: {
    empty: "Nothing moving. F5 copies, F6 moves.",
    /** The row's verb, keyed by the API's `TransferOperation`. */
    operation: {
      copy: "copy",
      move: "move",
    },
    done: {
      copiedOne: "Copied {count} entry",
      copiedMany: "Copied {count} entries",
      movedOne: "Moved {count} entry",
      movedMany: "Moved {count} entries",
    },
    doneDetail: "{size} into {path}",
    failedToast: "Transfer finished with failures",
    cancelFailed: "Could not cancel that transfer",
    retryFailed: "Could not retry that transfer",
    dismiss: "Dismiss",
    cancel: "Cancel",
    dismissLabel: "Dismiss {operation} into {path}",
    cancelLabel: "Cancel {operation}",
    unknownError: "Something went wrong.",
    retry: "retry {count}",
    queued: "queued",
    rate: "{size}/s",
    eta: {
      seconds: "{n}s",
      minutes: "{n}m",
      hours: "{n}h",
    },
  },
} as const;

export default ui;
