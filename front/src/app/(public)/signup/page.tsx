"use client";

import useCredentials from "@auth/helpers/useCredentials";
import { AuthCard, AuthLinks, AuthNotice } from "@components/auth/auth-card";
import { AuthField, StrengthMeter } from "@components/auth/auth-field";
import { zodResolver } from "@hookform/resolvers/zod";
import { interpolate } from "@i18n/interpolate";
import useTranslations from "@i18n/useTranslations";
import { ApiError } from "@lib/api/client";
import { fetchSignupStatus, register as registerAccount } from "@lib/api/users";
import { MIN_PASSPHRASE, registerSchema } from "@schemas/auth";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";

import type { AuthStatus } from "@components/auth/auth-card";
import type { RegisterValues } from "@schemas/auth";

export default function SignupPage() {
  const t = useTranslations("auth");
  const { setCredentials } = useCredentials();
  const [status, setStatus] = useState<AuthStatus>("IDLE");
  const [failure, setFailure] = useState<string | null>(null);

  // Asked rather than assumed: the guard is server-side, and a form that will
  // be refused is worse than a sentence explaining why (TRE-15 §5).
  const { data: open, isPending } = useQuery({
    queryKey: ["signupStatus"],
    queryFn: fetchSignupStatus,
    throwOnError: false,
  });

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<RegisterValues>({ resolver: zodResolver(registerSchema), mode: "onSubmit" });

  const onSubmit = async (values: RegisterValues) => {
    setStatus("WORKING");
    setFailure(null);
    try {
      const auth = await registerAccount(values.email, values.password, values.passphrase);
      setStatus("AUTHENTICATED");
      // Chosen, not generated — there is nothing to hand over and read out.
      setCredentials(auth);
    } catch (error) {
      setStatus("REJECTED");
      setFailure(error instanceof ApiError ? error.message : t.unreachable);
    }
  };

  // Closed, or not yet known: the form still renders, just inert. Removing it
  // would move every control on the screen and leave someone wondering whether
  // they are in the right place; disabling it says "not here, not now" while
  // keeping the way back to sign in exactly where it was (a sibling app does
  // the same).
  const locked = isPending || open === false;

  const links = (
    <AuthLinks
      links={[
        { href: "/login", label: t.links.signIn },
        { href: "/about", label: t.links.about },
      ]}
    />
  );

  return (
    <AuthCard
      title={t.title}
      subtitle={t.signup.subtitle}
      status={status}
      failure={failure}
      footer={links}
      notice={open === false ? <AuthNotice tone="warning">{t.signup.closed}</AuthNotice> : undefined}
    >
      <form
        onSubmit={handleSubmit(onSubmit)}
        className="flex flex-col gap-3"
        noValidate
      >
        <AuthField
          label={t.fields.identity}
          type="email"
          autoComplete="username"
          autoFocus
          registration={register("email")}
          error={errors.email?.message}
          disabled={locked}
        />

        <div className="flex flex-col gap-1.5">
          <AuthField
            label={t.fields.key}
            secret
            autoComplete="new-password"
            registration={register("password")}
            error={errors.password?.message}
            disabled={locked}
          />
          <StrengthMeter value={watch("password") ?? ""} />
        </div>

        <AuthField
          label={t.fields.confirmKey}
          secret
          autoComplete="new-password"
          registration={register("passwordConfirm")}
          error={errors.passwordConfirm?.message}
          disabled={locked}
        />

        <AuthNotice tone="warning">{t.signup.noRecoveryEmail}</AuthNotice>

        <AuthField
          label={t.fields.recoveryPassphrase}
          secret
          autoComplete="new-password"
          registration={register("passphrase")}
          error={errors.passphrase?.message}
          disabled={locked}
          hint={interpolate(t.signup.passphraseHint, { count: MIN_PASSPHRASE })}
        />
        <AuthField
          label={t.fields.confirmPassphrase}
          secret
          autoComplete="new-password"
          registration={register("passphraseConfirm")}
          error={errors.passphraseConfirm?.message}
          disabled={locked}
        />

        <button
          type="submit"
          disabled={isSubmitting || locked}
          className="border-accent text-ink hover:bg-accent/20 mt-1 rounded-xs border py-1.5 text-sm tracking-caps disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting ? t.signup.submitting : open === false ? t.signup.submitClosed : t.signup.submit}
        </button>
      </form>
    </AuthCard>
  );
}
