/** Returns `value` if it is a non-empty string, otherwise null. */
export function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}
