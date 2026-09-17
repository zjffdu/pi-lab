export function formatEcho(text: string): string {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return "I received an empty message. Send some text and I will echo it back.";
  }

  return `you said: ${trimmed}`;
}
