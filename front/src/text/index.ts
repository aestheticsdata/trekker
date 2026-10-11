/**
 * The string tree (TRE-116). Trekker is English-only, so there is one locale
 * and no switcher — but every word the app says lives here, one module per
 * zone, and no component holds a literal. `scripts/verify-text.ts` refuses one.
 *
 * **Module-scope reads are fine, on purpose.** With a single locale,
 * `dictionary` is a plain constant, so the zod schemas, the action registry and
 * the pure helpers read it when they load and stay what they are. A
 * multilingual app would have to turn each of them into a factory taking the
 * locale; this one does not, and should not be "fixed" into doing so.
 */
import actions from "@text/en/actions";
import app from "@text/en/app";
import auth from "@text/en/auth";
import dialogs from "@text/en/dialogs";
import explorer from "@text/en/explorer";
import hosts from "@text/en/hosts";
import inspector from "@text/en/inspector";
import query from "@text/en/query";
import shell from "@text/en/shell";
import sidebar from "@text/en/sidebar";
import terminal from "@text/en/terminal";
import ui from "@text/en/ui";
import validation from "@text/en/validation";
import views from "@text/en/views";

export const dictionary = {
  actions,
  app,
  auth,
  dialogs,
  explorer,
  hosts,
  inspector,
  query,
  shell,
  sidebar,
  terminal,
  ui,
  validation,
  views,
} as const;
