import type {
  ComputerController,
  ComputerMicroAction,
  ComputerPickerState,
  CropBox,
  ViewportSize,
} from "@eta/client-contracts";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const TRAJECTORY_EVENT_KINDS = [
  "open",
  "observe",
  "act",
  "picker",
  "takeover",
  "release",
  "pause",
  "stop",
  "verify",
] as const;

export type TrajectoryEventKind = (typeof TRAJECTORY_EVENT_KINDS)[number];

export interface TrajectoryEventInput {
  kind: TrajectoryEventKind;
  realmId: string;
  epoch: number;
  controller: ComputerController;
  summary: string;
  at?: number | undefined;
  actions?: readonly ComputerMicroAction[] | undefined;
  completedSteps?: number | undefined;
  interrupted?: boolean | undefined;
  crop?: CropBox | undefined;
  viewport?: ViewportSize | undefined;
  picker?: ComputerPickerState | undefined;
  verified?: boolean | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface TrajectoryEvent extends TrajectoryEventInput {
  seq: number;
  at: number;
}

export interface TrajectoryRecorderOptions {
  /** Maximum number of events retained in memory (default: 500). */
  maxEntries?: number | undefined;
  /** Optional path to an append-only JSONL file (e.g., `events.jsonl`). */
  filePath?: string | undefined;
}

export const DEFAULT_MAX_TRAJECTORY_ENTRIES = 500;

/**
 * Records structured `TrajectoryEvent` entries in a bounded in-memory ring buffer and optionally
 * appends each event as a JSON line (`events.jsonl`) for `cua-agent-kit`-style deterministic
 * script codification and auditability.
 */
export class TrajectoryRecorder {
  readonly maxEntries: number;
  readonly filePath: string | undefined;

  private readonly entries: TrajectoryEvent[] = [];
  private nextSeq = 1;
  private dirEnsured = false;

  constructor(options: TrajectoryRecorderOptions = {}) {
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_TRAJECTORY_ENTRIES;
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError(
        `Invalid TrajectoryRecorder maxEntries: ${String(maxEntries)}`,
      );
    }
    this.maxEntries = maxEntries;
    this.filePath = options.filePath;
  }

  /** Record a new trajectory event into the bounded ring buffer and optional JSONL file. */
  record(input: TrajectoryEventInput): TrajectoryEvent {
    const event: TrajectoryEvent = {
      ...input,
      seq: this.nextSeq++,
      at: input.at ?? Date.now(),
    };

    this.entries.push(event);
    while (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }

    if (this.filePath) {
      if (!this.dirEnsured) {
        mkdirSync(dirname(this.filePath), { recursive: true });
        this.dirEnsured = true;
      }
      appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
    }

    return event;
  }

  /** Return a shallow copy of recorded events currently in the ring buffer, optionally filtered by `realmId`. */
  list(realmId?: string): TrajectoryEvent[] {
    if (realmId === undefined) {
      return [...this.entries];
    }
    return this.entries.filter((entry) => entry.realmId === realmId);
  }

  /** Number of events currently stored in memory. */
  get size(): number {
    return this.entries.length;
  }

  /** Clear in-memory events. */
  clear(): void {
    this.entries.length = 0;
  }
}
