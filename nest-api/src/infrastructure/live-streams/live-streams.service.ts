import { Injectable } from "@nestjs/common";

import type { BeforeApplicationShutdown } from "@nestjs/common";
import type { Response } from "express";

/**
 * Every server-sent-events response still open, so a shutdown can end them (TRE-155).
 *
 * `app.close()` lets the HTTP server drain: it stops accepting connections and waits for the ones
 * still open to finish. A progress or tail stream never finishes on its own — it is closed by the
 * browser — so one open tab would hold every `pm2 reload` until PM2 gives up and kills the process.
 * Ended here instead, before the drain, each `EventSource` reconnects on its own to the new process.
 */
@Injectable()
export class LiveStreamsService implements BeforeApplicationShutdown {
  private readonly open = new Set<Response>();

  /** Registers a stream; call the returned function once it has closed. */
  hold(res: Response): () => void {
    this.open.add(res);
    return () => {
      this.open.delete(res);
    };
  }

  /** Before the HTTP drain, which these streams would otherwise hold open. */
  beforeApplicationShutdown(): void {
    for (const res of this.open) res.end();
    this.open.clear();
  }
}
