"use client";

import { AuthCard, AuthLinks } from "@components/auth/auth-card";
import { AuthField, StrengthMeter } from "@components/auth/auth-field";
import { zodResolver } from "@hookform/resolvers/zod";
import { ApiError } from "@lib/api/client";
import { recover } from "@lib/api/users";
import { recoverSchema } from "@schemas/auth";
import Link from "next/link";
import { useState } from "react";
import { useForm } from "react-hook-form";

import type { AuthStatus } from "@components/auth/auth-card";
import type { RecoverValues } from "@schemas/auth";

export default function RecoverPage() {
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
      setFailure(error instanceof ApiError ? error.message : "The API could not be reached.");
    }
  };

  const links = (
    <AuthLinks
      links={[
        { href: "/login", label: "sign in" },
        { href: "/about", label: "about" },
      ]}
    />
  );

  if (done) {
    return (
      <AuthCard
        title="TREKKER"
        subtitle="Key replaced"
        status="AUTHENTICATED"
        footer={links}
      >
        <p className="text-ink-muted text-sm leading-relaxed">
          The key is replaced and every existing session has been signed out — including any this account had open
          elsewhere. Sign in with the new one.
        </p>
        <Link
          href="/login"
          className="border-accent text-ink hover:bg-accent/20 mt-1 rounded-xs border py-1.5 text-center text-sm tracking-caps"
        >
          SIGN IN
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="TREKKER"
      subtitle="Recover"
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
          label="Identity"
          type="email"
          autoComplete="username"
          autoFocus
          registration={register("email")}
          error={errors.email?.message}
        />
        <AuthField
          label="Recovery passphrase"
          secret
          autoComplete="off"
          registration={register("passphrase")}
          error={errors.passphrase?.message}
        />

        <div className="flex flex-col gap-1.5">
          <AuthField
            label="New key"
            secret
            autoComplete="new-password"
            registration={register("newPassword")}
            error={errors.newPassword?.message}
          />
          <StrengthMeter value={watch("newPassword") ?? ""} />
        </div>

        <AuthField
          label="Confirm new key"
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
          {isSubmitting ? "REPLACING…" : "REPLACE KEY"}
        </button>
      </form>
    </AuthCard>
  );
}
