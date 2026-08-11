"use client";

import useCredentials from "@auth/helpers/useCredentials";
import { AuthCard, AuthLinks, AuthNotice } from "@components/auth/auth-card";
import { AuthField, StrengthMeter } from "@components/auth/auth-field";
import { zodResolver } from "@hookform/resolvers/zod";
import { ApiError } from "@lib/api/client";
import { fetchSignupStatus, register as registerAccount } from "@lib/api/users";
import { MIN_PASSPHRASE, registerSchema } from "@schemas/auth";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";

import type { RegisterResponse } from "@auth/interfaces/authTypes";
import type { AuthStatus } from "@components/auth/auth-card";
import type { RegisterValues } from "@schemas/auth";

export default function SignupPage() {
  const { setCredentials } = useCredentials();
  const [status, setStatus] = useState<AuthStatus>("IDLE");
  const [failure, setFailure] = useState<string | null>(null);
  // Held only long enough to be written down. Never stored, never re-fetchable.
  const [issued, setIssued] = useState<RegisterResponse | null>(null);

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
      setIssued(await registerAccount(values.email, values.password));
      setStatus("AUTHENTICATED");
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

  if (issued) {
    return (
      <PassphraseHandover
        issued={issued}
        onAcknowledge={() => setCredentials(issued)}
        footer={links}
      />
    );
  }

  if (isPending) {
    return (
      <AuthCard
        title="TREKKER"
        subtitle="Register"
        footer={links}
      >
        <p className="text-ink-faint text-sm">Checking whether registration is open…</p>
      </AuthCard>
    );
  }

  if (open === false) {
    return (
      <AuthCard
        title="TREKKER"
        subtitle="Register"
        footer={links}
        notice={<AuthNotice tone="warning">Registration is closed on this instance.</AuthNotice>}
      >
        <p className="text-ink-muted text-sm leading-relaxed">
          An open sign-up on an app that stores SSH keys is not a feature. Whoever runs this instance opens registration
          deliberately — the README explains how.
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="TREKKER"
      subtitle="Register"
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

        <div className="flex flex-col gap-1.5">
          <AuthField
            label="Key"
            secret
            autoComplete="new-password"
            registration={register("password")}
            error={errors.password?.message}
          />
          <StrengthMeter value={watch("password") ?? ""} />
        </div>

        <AuthField
          label="Confirm key"
          secret
          autoComplete="new-password"
          registration={register("passwordConfirm")}
          error={errors.passwordConfirm?.message}
        />

        <AuthNotice tone="warning">
          There is no recovery email. The passphrase below is the only way back into this account — write it down before
          you continue.
        </AuthNotice>

        <AuthField
          label="Recovery passphrase"
          secret
          autoComplete="new-password"
          registration={register("passphrase")}
          error={errors.passphrase?.message}
          hint={`At least ${MIN_PASSPHRASE} characters. A sentence works better than a word.`}
        />
        <AuthField
          label="Confirm passphrase"
          secret
          autoComplete="new-password"
          registration={register("passphraseConfirm")}
          error={errors.passphraseConfirm?.message}
        />

        <button
          type="submit"
          disabled={isSubmitting}
          className="border-accent text-ink hover:bg-accent/20 mt-1 rounded-xs border py-1.5 text-sm tracking-caps disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting ? "CREATING…" : "CREATE ACCOUNT"}
        </button>
      </form>
    </AuthCard>
  );
}

/**
 * The passphrase, shown exactly once (TRE-15 security).
 *
 * The account already exists at this point, so the only thing standing between
 * the user and losing it forever is this screen. It refuses to move on until
 * they say they have written it down.
 */
function PassphraseHandover({
  issued,
  onAcknowledge,
  footer,
}: {
  issued: RegisterResponse;
  onAcknowledge: () => void;
  footer: React.ReactNode;
}) {
  const [acknowledged, setAcknowledged] = useState(false);

  return (
    <AuthCard
      title="TREKKER"
      subtitle="Write this down"
      status="AUTHENTICATED"
      footer={footer}
      notice={
        <AuthNotice tone="warning">
          This is the only time this passphrase is shown. It cannot be retrieved, reset or emailed.
        </AuthNotice>
      }
    >
      <p className="text-ink-muted text-xs tracking-label">Recovery passphrase</p>
      <p className="border-line-strong bg-chrome text-ink rounded-xs border px-3 py-2.5 font-mono text-base leading-relaxed break-words select-all">
        {issued.recoveryPassphrase}
      </p>

      <label className="text-ink-muted flex items-start gap-2 text-sm leading-relaxed">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
          className="mt-0.5"
        />
        I have written down this passphrase somewhere safe.
      </label>

      <button
        type="button"
        disabled={!acknowledged}
        onClick={onAcknowledge}
        className="border-accent text-ink hover:bg-accent/20 mt-1 rounded-xs border py-1.5 text-sm tracking-caps disabled:cursor-not-allowed disabled:opacity-60"
      >
        CONTINUE
      </button>
    </AuthCard>
  );
}
