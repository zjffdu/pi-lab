/**
 * Named checkpoints: the places where this lab's failure injections may interrupt a run.
 *
 * Production code calls `checkpoints.hit(name, context)` at each named point. With no plan installed
 * that is a no-op. A test, the demo, or a child process (through the `FAULTS` environment variable)
 * installs a plan that says what happens the Nth time a name is hit. Naming the points is the
 * point: "crash after the receiver committed but before the worker recorded the result" is a
 * place in the code, not a race a test hopes to win.
 */
export const CHECKPOINTS = [
  // Application transaction
  "admit.before_commit", // approval consumed + outbox row inserted, transaction not yet committed
  // Delivery worker (`deliver` and `reconcile` claims)
  "worker.after_claim", // lease held and committed, nothing sent yet
  "worker.before_send", // about to call the receiver
  "worker.after_response", // the receiver's answer is in memory; nothing recorded locally yet
  "worker.before_result_commit", // about to run the fenced result transaction
  "worker.after_result_commit", // result durably recorded
  // Receiver (fault kinds `drop` and `http` are interpreted by the receiver)
  "receiver.before_apply", // request read, nothing applied
  "receiver.after_apply", // effect committed at the receiver, response not yet written
] as const;
export type CheckpointName = (typeof CHECKPOINTS)[number];

export type FaultAction =
  /** Throw `SimulatedCrash`: the caller's in-memory state is gone, database state stays as it was. */
  | { kind: "crash" }
  /** `SIGKILL` the current process. Only meaningful in a child process. */
  | { kind: "kill" }
  /** Wait until `release(name)` is called (or `ms` elapse) — a stalled worker or a slow receiver. */
  | { kind: "pause"; ms?: number }
  | { kind: "delay"; ms: number }
  /** Receiver only: destroy the connection without writing a response. */
  | { kind: "drop" }
  /** Receiver only: answer with this status instead of the real response. */
  | { kind: "http"; status: number };

export interface Fault {
  at: CheckpointName;
  action: FaultAction;
  /** How many hits it applies to before it stops firing. Defaults to 1. */
  times?: number;
  /** Optional filter on the hit's context, e.g. only for one worker. */
  match?: Record<string, string | number>;
}

export class SimulatedCrash extends Error {
  public constructor(public readonly checkpoint: CheckpointName) {
    super(`simulated crash at ${checkpoint}`);
    this.name = "SimulatedCrash";
  }
}

export type HitContext = Record<string, string | number>;

/** What `hit` returns to the caller when the fault is one the caller must act on itself. */
export type Directive = { kind: "drop" } | { kind: "http"; status: number } | undefined;

export class Checkpoints {
  private readonly remaining: Array<{ fault: Fault; left: number }>;
  private readonly hits = new Map<CheckpointName, number>();
  private readonly gates = new Map<CheckpointName, Array<() => void>>();

  public constructor(plan: readonly Fault[] = []) {
    this.remaining = plan.map((fault) => ({ fault, left: fault.times ?? 1 }));
  }

  /** How many times a checkpoint has been reached (whether or not a fault fired). */
  public hitCount(name: CheckpointName): number {
    return this.hits.get(name) ?? 0;
  }

  public add(fault: Fault): void {
    this.remaining.push({ fault, left: fault.times ?? 1 });
  }

  /** Lets every worker paused at `name` continue. */
  public release(name: CheckpointName): void {
    for (const resume of this.gates.get(name) ?? []) resume();
    this.gates.delete(name);
  }

  /** Resolves once at least one caller is paused at `name` — lets a test act while a worker is stalled. */
  public async waitUntilPaused(name: CheckpointName, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while ((this.gates.get(name)?.length ?? 0) === 0) {
      if (Date.now() > deadline) throw new Error(`nobody paused at ${name}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  public async hit(name: CheckpointName, context: HitContext = {}): Promise<Directive> {
    this.hits.set(name, this.hitCount(name) + 1);
    const entry = this.remaining.find((candidate) => candidate.left > 0 && candidate.fault.at === name && matches(candidate.fault.match, context));
    if (!entry) return undefined;
    entry.left -= 1;
    const action = entry.fault.action;
    switch (action.kind) {
      case "crash":
        throw new SimulatedCrash(name);
      case "kill":
        process.kill(process.pid, "SIGKILL");
        return undefined;
      case "delay":
        await new Promise((resolve) => setTimeout(resolve, action.ms));
        return undefined;
      case "pause":
        await new Promise<void>((resolve) => {
          const list = this.gates.get(name) ?? [];
          list.push(resolve);
          this.gates.set(name, list);
          if (action.ms !== undefined) setTimeout(resolve, action.ms);
        });
        return undefined;
      case "drop":
        return { kind: "drop" };
      case "http":
        return { kind: "http", status: action.status };
    }
  }
}

function matches(filter: Fault["match"], context: HitContext): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([key, value]) => context[key] === value);
}

export const noCheckpoints = new Checkpoints();

const isFault = (value: unknown): value is Fault => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (CHECKPOINTS as readonly unknown[]).includes(candidate.at) && typeof candidate.action === "object" && candidate.action !== null;
};

/** Parses the `FAULTS` environment variable a child process receives. Invalid input is an error, not a no-op. */
export function faultsFromEnvironment(raw: string | undefined): Fault[] {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isFault)) throw new Error("FAULTS must be a JSON array of { at, action } with a known checkpoint name");
  return parsed;
}
