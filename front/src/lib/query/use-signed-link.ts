"use client";

import { useAuth } from "@auth/context/AuthContext";
import { useToast } from "@components/ui/toast";
import { interpolate } from "@i18n/interpolate";
import useTranslations from "@i18n/useTranslations";
import { ApiError } from "@lib/api/client";
import { mintLink } from "@lib/api/link";
import { useMutation } from "@tanstack/react-query";

/**
 * Minting a signed link, which ends in the clipboard (TRE-66).
 *
 * The URL *is* the grant — anything that can read it can fetch the file — so it
 * is never rendered into the page. Showing it would put a working credential on
 * screen for a shoulder, a screenshot or a screen share, and it would stay
 * there for as long as the panel did. Straight to the clipboard, and the toast
 * says when it expires rather than what it is.
 *
 * Shared rather than written twice (TRE-70): the inspector's button and the
 * context menu's entry mint the same link, and the rule about never printing it
 * is the kind that survives in one place and rots in two.
 */
export function useSignedLink() {
  const t = useTranslations("query");
  const { csrfToken } = useAuth();
  const { push } = useToast();

  return useMutation({
    mutationFn: ({ hostId, path }: { hostId: string; path: string }) => mintLink(hostId, path, csrfToken),
    throwOnError: false,
    onSuccess: async (minted) => {
      const expires = new Date(minted.expiresAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
      try {
        await navigator.clipboard.writeText(minted.url);
        push({
          tone: "success",
          message: t.signedLink.copied,
          detail: interpolate(t.signedLink.copiedDetail, { filename: minted.filename, time: expires }),
        });
      } catch {
        // Clipboard access is refused on an insecure origin and in some
        // configurations. The link exists either way, so say so rather than
        // reporting a failure that did not happen — and do not print the URL,
        // for the reason above.
        push({
          tone: "warning",
          message: t.signedLink.notCopied,
          detail: t.signedLink.notCopiedDetail,
        });
      }
    },
    onError: (error) => {
      push({
        tone: "danger",
        message: t.signedLink.failed,
        detail: error instanceof ApiError ? error.message : t.signedLink.failedDetail,
      });
    },
  });
}
