// The runtime's events, in order, to the control plane: one JetStream subject
// per agent (axp.agent.<agent>.events). Every event carries this process's
// boot id and its sequence number in the boot; the message id is both, so a
// retried publish is stored once. Unsent events wait in memory, in order:
// a runtime that dies loses what it had not sent, and the control plane
// settles its work when the next boot reports itself (runtime.started).

export type Publish = (
  subject: string,
  data: string,
  messageId: string,
) => Promise<void>;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class Outbox {
  private seq = 0;
  private readonly pending: { id: string; data: string }[] = [];
  private sending: Promise<void> | null = null;

  constructor(
    private readonly publish: Publish,
    private readonly subject: string,
    readonly bootId: string,
  ) {}

  emit = (type: string, payload: Record<string, unknown>): void => {
    this.seq += 1;
    const data = JSON.stringify({
      boot_id: this.bootId,
      seq: this.seq,
      type,
      payload,
    });
    this.pending.push({ id: `${this.bootId}:${this.seq}`, data });
    this.kick();
  };

  /** Resolves once every event so far is sent, or after timeoutMs. */
  async drain(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.pending.length > 0 && Date.now() < deadline) {
      await sleep(20);
    }
    return this.pending.length === 0;
  }

  private kick(): void {
    if (this.sending !== null) {
      return;
    }
    this.sending = this.send().finally(() => {
      this.sending = null;
      if (this.pending.length > 0) {
        this.kick();
      }
    });
  }

  private async send(): Promise<void> {
    let backoff = 200;
    while (this.pending.length > 0) {
      const next = this.pending[0]!;
      try {
        await this.publish(this.subject, next.data, next.id);
        this.pending.shift();
        backoff = 200;
      } catch (error) {
        console.warn("Publishing an event failed; retrying", error);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 5000);
      }
    }
  }
}
