/**
 * Shared marker format between a fixture tool that announces "I have been dispatched, my
 * durable tool-call is already committed" and a parent process watching a child's stdout
 * for that exact moment. This is the "named checkpoint" the roadmap requires instead of an
 * arbitrary wall-clock sleep: the parent never guesses when the child has reached the
 * interesting state, it waits for the child to say so.
 */

export const CHECKPOINT_PREFIX = "[Checkpoint]";

export interface CheckpointFields {
  name: string;
  toolCallId: string;
  tool: string;
  [key: string]: string;
}

export function formatCheckpoint(fields: CheckpointFields): string {
  const { name, ...rest } = fields;
  const parts = Object.entries(rest).map(([key, value]) => `${key}=${value}`);
  return `${CHECKPOINT_PREFIX} ${name} ${parts.join(" ")}`.trimEnd();
}

/** Returns the checkpoint name from a stdout line, or undefined if the line is not one. */
export function parseCheckpointName(line: string): string | undefined {
  if (!line.startsWith(CHECKPOINT_PREFIX)) {
    return undefined;
  }
  return line.slice(CHECKPOINT_PREFIX.length).trim().split(" ")[0];
}
