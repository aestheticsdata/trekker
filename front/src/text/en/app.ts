/** The document itself and the two error boundaries (TRE-89). */
const app = {
  metadata: {
    title: "Trekker",
    description: "A file explorer for the servers you actually run.",
  },
  error: {
    message: "Something broke.",
    retry: "RETRY",
  },
  globalError: {
    message: "Trekker could not start.",
    retry: "RETRY",
  },
} as const;

export default app;
