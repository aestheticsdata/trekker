import { interpolate } from "@i18n/interpolate";
import { dictionary } from "@text/index";
import { z } from "zod";

/**
 * The host form's rules (TRE-43), the same ones the API enforces.
 *
 * Duplicated on purpose: the server is the authority — it is the only side an
 * attacker cannot skip — and this copy exists so a typo is answered while
 * someone is still typing rather than by a round trip. Where they disagree the
 * server wins and its message is shown.
 */

/** VarChar(700) in the schema; the same ceiling, said earlier. */
const MAX_PATH = 700;

const MESSAGES = dictionary.validation.host;

const ABSOLUTE_PATH = z
  .string()
  .trim()
  .min(1, { message: MESSAGES.pathRequired })
  .max(MAX_PATH, { message: interpolate(MESSAGES.pathMax, { max: MAX_PATH }) })
  .refine((value) => value.startsWith("/"), { message: MESSAGES.pathAbsolute });

export const rootSchema = z.object({
  path: ABSOLUTE_PATH,
  access: z.enum(["READ", "WRITE"]),
});

export const CREDENTIAL_KINDS = ["PRIVATE_KEY", "PASSWORD", "AGENT"] as const;

/** What each credential kind actually asks you to paste. */
export const CREDENTIAL_LABELS: Record<(typeof CREDENTIAL_KINDS)[number], string> = MESSAGES.credentialKinds;

/**
 * A schema per form, because two rules depend on the circumstances rather than
 * on the values: a new SSH host must arrive with a credential (the API refuses
 * it otherwise) while an edit leaves the field blank to keep the stored one,
 * and the two roots rules bind every account except the install's owner, whose
 * paths resolve against `/` whatever the list says (TRE-48). Everything else is
 * the same, so those are parameters rather than three schemas to keep in step.
 *
 * The relaxation is cosmetic in the strict sense — the API decides, and it now
 * decides the same way (TRE-49). What it buys is an owner who is not stopped by
 * a message predicting a refusal that would not happen.
 */
export const hostSchemaFor = ({ requireCredential, owner }: { requireCredential: boolean; owner: boolean }) =>
  z
    .object({
      label: z.string().trim().min(1, { message: MESSAGES.nameRequired }).max(64, { message: MESSAGES.nameMax }),
      transport: z.enum(["LOCAL", "SSH"]),
      colour: z.string().regex(/^#[0-9a-fA-F]{6}$/, { message: MESSAGES.colour }),
      homePath: ABSOLUTE_PATH,
      roots: owner ? z.array(rootSchema) : z.array(rootSchema).min(1, { message: MESSAGES.rootsRequired }),

      // SSH only. Kept in the object rather than behind a discriminated union so
      // that switching transport does not throw away what was already typed.
      //
      // Every one of them is a plain string, including the port: the field is a
      // text input, and coercing in the schema would make the form's input and
      // output types diverge for no gain. The number is made at submit.
      address: z.string().trim(),
      port: z
        .string()
        .trim()
        .refine((value) => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 65535, {
          message: MESSAGES.port,
        }),
      username: z.string().trim(),
      credentialKind: z.enum(CREDENTIAL_KINDS),
      credentialSecret: z.string(),
    })
    .superRefine((values, context) => {
      if (values.transport !== "SSH") return;

      if (values.address === "") {
        context.addIssue({ code: "custom", path: ["address"], message: MESSAGES.addressRequired });
      }
      if (values.username === "") {
        context.addIssue({ code: "custom", path: ["username"], message: MESSAGES.usernameRequired });
      }
      if (requireCredential && values.credentialSecret === "") {
        context.addIssue({
          code: "custom",
          path: ["credentialSecret"],
          message: interpolate(MESSAGES.credentialRequired, { credential: CREDENTIAL_LABELS[values.credentialKind] }),
        });
      }
    })
    // The home has to sit inside a root or the pane opens on a refusal. Checked
    // as strings here and again on the host after resolution, where a symlink
    // can still change the answer — and not at all for an owner, for whom the
    // refusal being predicted cannot occur.
    .refine((values) => owner || values.roots.some((root) => contains(root.path, values.homePath)), {
      message: MESSAGES.homeOutsideRoots,
      path: ["homePath"],
    });

export type HostFormValues = z.infer<ReturnType<typeof hostSchemaFor>>;

/** Segment-wise, so `/data` does not admit `/database`. */
export function contains(root: string, path: string): boolean {
  const ancestor = cleanPath(root);
  const target = cleanPath(path);
  return target === ancestor || target.startsWith(ancestor === "/" ? "/" : `${ancestor}/`);
}

/** Collapses duplicate separators and drops the trailing slash, as the API does. */
export function cleanPath(path: string): string {
  return `/${path.trim().split("/").filter(Boolean).join("/")}`;
}

/** The eight host accents, from the pane palette — a picker, not a colour wheel. */
export const HOST_COLOURS = [
  "#7fa8c9",
  "#b9dcea",
  "#3e8fae",
  "#7fd6a8",
  "#c98a3e",
  "#e39a9a",
  "#a99fc0",
  "#8fae97",
] as const;
