/** The toasts the shared mutations raise (TRE-27, TRE-66). */
const query = {
  signedLink: {
    copied: "Link copied",
    copiedDetail: "{filename} · expires at {time}",
    notCopied: "Link created, but not copied",
    notCopiedDetail: "This browser refused clipboard access. Try again from a secure origin.",
    failed: "No link",
    failedDetail: "The link could not be created.",
  },
  hashJob: {
    failed: "No checksums",
    failedDetail: "The job could not be queued.",
  },
} as const;

export default query;
