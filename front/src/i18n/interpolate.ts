/**
 * Fills `{token}` holes in a dictionary string, so word order stays in the
 * dictionary rather than being assembled in JSX: `"{count} hosts"`, not
 * `` `${count} hosts` `` (TRE-116).
 *
 * An unmatched token renders literally, so a typo shows on screen instead of
 * quietly dropping the value.
 */
export const interpolate = (template: string, values: Record<string, string | number>): string =>
  template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, token: string) =>
    values[token] === undefined ? match : String(values[token]),
  );
