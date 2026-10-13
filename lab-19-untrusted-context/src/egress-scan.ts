/**
 * A value that must not leave the process toward a model provider, a client, or an outbound tool.
 * `label` is what logs and errors may say; `value` is only ever compared against, never printed.
 */
export interface ForbiddenValue {
  label: string;
  value: string;
}

/** Substring match that also catches the JSON-escaped form (a value serialized inside tool-call arguments). */
export function containsValue(haystack: string, value: string): boolean {
  if (value === "") return false;
  return haystack.includes(value) || haystack.includes(JSON.stringify(value).slice(1, -1));
}

/** Labels of every forbidden value found in any of the haystacks. Never returns the values. */
export function findForbiddenLabels(haystacks: readonly string[], forbidden: readonly ForbiddenValue[]): string[] {
  const labels = new Set<string>();
  for (const item of forbidden) {
    if (haystacks.some((haystack) => containsValue(haystack, item.value))) labels.add(item.label);
  }
  return [...labels];
}
