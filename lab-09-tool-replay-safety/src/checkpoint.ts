/**
 * Shared marker format between a fixture tool that announces a named moment in its own
 * execution and a parent process watching a child's stdout for that exact moment. This is
 * the "named checkpoint" the roadmap requires instead of an arbitrary wall-clock sleep: the
 * parent never guesses when the child has reached the interesting state, it waits for the
 * child to say so.
 *
 * Lab 08 used one checkpoint name per tool ("tool_dispatched"). Lab 09's two tools need two
 * *different* moments to be killable at: the safe tool is killed right after it starts (same
 * as Lab 08), but the unsafe tool must be killed after its local effect is already
 * durable but before its result is committed — so it prints a second checkpoint,
 * "effect_appended", between those two moments.
 */

export const CHECKPOINT_PREFIX = "[Checkpoint]";

export interface CheckpointFields {
  name: string;
  tool: string;
  [key: string]: string;
}

export function formatCheckpoint(fields: CheckpointFields): string {
  const { name, ...rest } = fields;
  const parts = Object.entries(rest).map(([key, value]) => `${key}=${value}`);
  return `${CHECKPOINT_PREFIX} ${name} ${parts.join(" ")}`.trimEnd();
}

export interface ParsedCheckpoint {
  name: string;
  fields: Record<string, string>;
}

/** Returns the checkpoint name and fields from a stdout line, or undefined if not one. */
export function parseCheckpoint(line: string): ParsedCheckpoint | undefined {
  if (!line.startsWith(CHECKPOINT_PREFIX)) {
    return undefined;
  }
  const rest = line.slice(CHECKPOINT_PREFIX.length).trim();
  const [name, ...parts] = rest.split(" ");
  if (!name) {
    return undefined;
  }
  const fields: Record<string, string> = {};
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      continue;
    }
    fields[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return { name, fields };
}

/** Returns the checkpoint name from a stdout line, or undefined if the line is not one. */
export function parseCheckpointName(line: string): string | undefined {
  return parseCheckpoint(line)?.name;
}
