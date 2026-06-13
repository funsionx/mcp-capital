/** Read a required env var, throwing a clear, source-attributable error if absent. */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v.trim();
}

/** Read an optional env var; returns undefined when unset/empty. */
export function optionalEnv(name: string): string | undefined {
  const v = process.env[name];
  if (!v || v.trim() === "") return undefined;
  return v.trim();
}
