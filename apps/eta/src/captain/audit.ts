import { mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface CaptainAuditEntry {
  at: number;
  action: string;
  actorAgentId?: string | null;
  data?: Record<string, unknown>;
}

/** Short, append-only operations log. Reads are deliberately never written here. */
export class CaptainAudit {
  readonly path: string;
  #tail: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.path = join(dataDir, "captain", "operations.jsonl");
  }

  record(entry: Omit<CaptainAuditEntry, "at">): Promise<void> {
    const line = `${JSON.stringify({ at: Date.now(), ...entry })}\n`;
    const write = async (): Promise<void> => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const handle = await open(this.path, "a", 0o600);
      try {
        await handle.write(line);
        await handle.sync();
      } finally {
        await handle.close();
      }
    };
    const next = this.#tail.then(write, write);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}
