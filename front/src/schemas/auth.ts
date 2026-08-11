import { z } from "zod";

/**
 * The auth boundary, parsed rather than cast (TRE-15).
 *
 * Deliberately plain `z.object`, never `.strict()`: zod strips unknown keys by
 * default, so a field added server-side stays backward compatible. A strict
 * schema would turn any such addition into a hard sign-in failure.
 */

export const AuthUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  /** Whether recovery is even possible for this account. */
  hasRecoveryPassphrase: z.boolean(),
});

export const AuthResponseSchema = z.object({
  user: AuthUserSchema,
  csrfToken: z.string(),
});

/**
 * Registration answers with everything sign-in does, plus the one thing that
 * is shown exactly once and can never be read back.
 */
export const RegisterResponseSchema = AuthResponseSchema.extend({
  recoveryPassphrase: z.string(),
});

export const SignupStatusSchema = z.object({ open: z.boolean() });

// ---- form rules ----------------------------------------------------------
//
// Two different minimums on the same field is not an oversight: sign-in must
// accept whatever an older account already has, while registration sets the
// floor for every new one. The API enforces 12 on the way in.

const EMAIL = z.email({ message: "That does not look like an email address." });

export const MIN_KEY_SIGN_IN = 8;
export const MIN_KEY_REGISTER = 12;
export const MIN_PASSPHRASE = 20;

export const signInSchema = z.object({
  email: EMAIL,
  password: z.string().min(MIN_KEY_SIGN_IN, { message: `The key is at least ${MIN_KEY_SIGN_IN} characters.` }),
});

export const registerSchema = z
  .object({
    email: EMAIL,
    password: z
      .string()
      .min(MIN_KEY_REGISTER, { message: `A new key must be at least ${MIN_KEY_REGISTER} characters.` }),
    passwordConfirm: z.string(),
    passphrase: z
      .string()
      .min(MIN_PASSPHRASE, { message: `The recovery passphrase must be at least ${MIN_PASSPHRASE} characters.` }),
    passphraseConfirm: z.string(),
  })
  // Each mismatch names its own field: "check the fields" tells someone who
  // typed two long strings nothing about which one to look at.
  .refine((values) => values.password === values.passwordConfirm, {
    message: "The two keys do not match.",
    path: ["passwordConfirm"],
  })
  .refine((values) => values.passphrase === values.passphraseConfirm, {
    message: "The two passphrases do not match.",
    path: ["passphraseConfirm"],
  });

export const recoverSchema = z
  .object({
    email: EMAIL,
    passphrase: z.string().min(1, { message: "The recovery passphrase is required." }),
    newPassword: z
      .string()
      .min(MIN_KEY_REGISTER, { message: `A new key must be at least ${MIN_KEY_REGISTER} characters.` }),
    newPasswordConfirm: z.string(),
  })
  .refine((values) => values.newPassword === values.newPasswordConfirm, {
    message: "The two keys do not match.",
    path: ["newPasswordConfirm"],
  });

export type SignInValues = z.infer<typeof signInSchema>;
export type RegisterValues = z.infer<typeof registerSchema>;
export type RecoverValues = z.infer<typeof recoverSchema>;

/**
 * The four-cell strength meter. Guidance, not a gate — the only hard rule is
 * the length minimum above, and a meter that refused to submit would push
 * people toward whatever pattern happens to light all four cells.
 */
export function scoreKey(key: string): number {
  let score = 0;
  if (key.length >= 8) score++;
  if (key.length >= 12) score++;
  if (/[a-z]/.test(key) && /[A-Z]/.test(key)) score++;
  if (/\d/.test(key) && /[^\w\s]/.test(key)) score++;
  return score;
}

export const STRENGTH_LABELS = ["", "weak", "fair", "good", "strong"] as const;
