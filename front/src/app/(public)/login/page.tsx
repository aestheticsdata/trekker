"use client";

import useCredentials from "@auth/helpers/useCredentials";
import { AuthCard, AuthLinks } from "@components/auth/auth-card";
import { AuthField } from "@components/auth/auth-field";
import { zodResolver } from "@hookform/resolvers/zod";
import { ApiError } from "@lib/api/client";
import { signIn } from "@lib/api/users";
import { signInSchema } from "@schemas/auth";
import { useState } from "react";
import { useForm } from "react-hook-form";

import type { AuthStatus } from "@components/auth/auth-card";
import type { SignInValues } from "@schemas/auth";

export default function LoginPage() {
  const { setCredentials } = useCredentials();
  const [status, setStatus] = useState<AuthStatus>("IDLE");
  const [failure, setFailure] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignInValues>({
    resolver: zodResolver(signInSchema),
    mode: "onSubmit",
  });

  const onSubmit = async (values: SignInValues) => {
    setStatus("WORKING");
    setFailure(null);
    try {
      const auth = await signIn(values.email, values.password);
      setStatus("AUTHENTICATED");
      setCredentials(auth);
    } catch (error) {
      setStatus("REJECTED");
      // The API's own words. "Invalid credentials" is deliberately vague on
      // the server side — it must not say which half was wrong — and that
      // vagueness is the message, not something to replace.
      setFailure(error instanceof ApiError ? error.message : "The API could not be reached.");
    }
  };

  return (
    <AuthCard
      title="TREKKER"
      subtitle="Sign in"
      status={status}
      failure={failure}
      footer={
        <AuthLinks
          links={[
            { href: "/signup", label: "register" },
            { href: "/recover", label: "recover" },
            { href: "/about", label: "about" },
          ]}
        />
      }
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
          label="Key"
          secret
          autoComplete="current-password"
          registration={register("password")}
          error={errors.password?.message}
        />

        <button
          type="submit"
          disabled={isSubmitting}
          className="border-accent text-ink hover:bg-accent/20 mt-1 rounded-xs border py-1.5 text-sm tracking-caps disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting ? "CONNECTING…" : "CONNECT"}
        </button>
      </form>
    </AuthCard>
  );
}
