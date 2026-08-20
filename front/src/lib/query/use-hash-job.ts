"use client";

import { useAuth } from "@auth/context/AuthContext";
import { useToast } from "@components/ui/toast";
import { ApiError } from "@lib/api/client";
import { startHash } from "@lib/api/hashes";
import { QUERY_KEYS } from "@lib/query/keys";
import { useMutation, useQueryClient } from "@tanstack/react-query";

/**
 * Queueing a checksum job (TRE-27 §3).
 *
 * Shared rather than written twice, for the reason `useSignedLink` gives: the
 * context menu queues one over a selection and the inspector queues one over
 * the file it is describing, and they are the same request. When TRE-36's
 * palette lands it will be the third caller and will need no new code.
 *
 * **The success path is deliberately quiet.** A job that starts is a job whose
 * progress the panel is already about to show, and a toast saying "queued"
 * would be a second, worse copy of that. What does get a toast is the refusal:
 * a selection over the bounds comes back with the numbers in it, and those
 * numbers are the whole point of refusing rather than grinding.
 *
 * The invalidation is what makes a cached digest appear instantly. A job of
 * four hundred files that the cache already covers finishes before any frame of
 * the feed arrives, and without this the panel would sit on "not computed" for
 * a file whose digest was already in the database.
 */
export function useHashJob() {
  const { csrfToken } = useAuth();
  const { push } = useToast();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ hostId, paths }: { hostId: string; paths: string[] }) => startHash(hostId, paths, csrfToken),
    throwOnError: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.HASH] });
    },
    onError: (error) => {
      push({
        tone: "danger",
        message: "No checksums",
        detail: error instanceof ApiError ? error.message : "The job could not be queued.",
      });
    },
  });
}
