"use client";

import { AuthCard, AuthLinks } from "@components/auth/auth-card";
import { AuthField, StrengthMeter } from "@components/auth/auth-field";
import { zodResolver } from "@hookform/resolvers/zod";
import useTranslations from "@i18n/useTranslations";
import { ApiError } from "@lib/api/client";
import { recover } from "@lib/api/users";
import { recoverSchema } from "@schemas/auth";
import Link from "next/link";
import { useState } from "react";
import { useForm } from "react-hook-form";

import type { AuthStatus } from "@components/auth/auth-card";
import type { RecoverValues } from "@schemas/auth";

export default function RecoverPage() {
  const t = useTranslations("auth");
  const [status, setStatus] = useState<AuthStatus>("IDLE");
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<RecoverValues>({ resolver: zodResolver(recoverSchema), mode: "onSubmit" });

  const onSubmit = async (values: RecoverValues) => {
    setStatus("WORKING");
    setFailure(null);
    try {
      await recover(values.email, values.passphrase, values.newPassword);
      setStatus("AUTHENTICATED");
      setDone(true);
    } catch (error) {
      setStatus("REJECTED");
      setFailure(error instanceof ApiError ? error.message : t.unreachable);
    }
  };

  const links = (
    <AuthLinks
      links={[
        { href: "/login", label: t.links.signIn },
        { href: "/about", label: t.links.about },
      ]}
    />
  );

  if (done) {
    return (
      <AuthCard
        title={t.title}
        subtitle={t.recover.done.subtitle}
        status="AUTHENTICATED"
        footer={links}
      >
        <p className="text-ink-muted text-sm leading-relaxed">{t.recover.done.body}</p>
        <Link
          href="/login"
          className="border-accent text-ink hover:bg-accent/20 mt-1 rounded-xs border py-1.5 text-center text-sm tracking-caps"
        >
          {t.recover.done.signIn}
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={t.title}
      subtitle={t.recover.subtitle}
      status={status}
      failure={failure}
      footer={links}
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
        />
        <AuthField
          label={t.fields.recoveryPassphrase}
          secret
          autoComplete="off"
          registration={register("passphrase")}
          error={errors.passphrase?.message}
        />

        <div className="flex flex-col gap-1.5">
          <AuthField
            label={t.fields.newKey}
            secret
            autoComplete="new-password"
            registration={register("newPassword")}
            error={errors.newPassword?.message}
          />
          <StrengthMeter value={watch("newPassword") ?? ""} />
        </div>

        <AuthField
          label={t.fields.confirmNewKey}
          secret
          autoComplete="new-password"
          registration={register("newPasswordConfirm")}
          error={errors.newPasswordConfirm?.message}
        />

        <button
          type="submit"
          disabled={isSubmitting}
          className="border-accent text-ink hover:bg-accent/20 mt-1 rounded-xs border py-1.5 text-sm tracking-caps disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting ? t.recover.submitting : t.recover.submit}
        </button>
      </form>
    </AuthCard>
  );
}
