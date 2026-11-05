// A host inside the app's own VM: it speaks the same frames as the real one, holds the design's data
// and answers the ops the screens call. DevApp runs on it in the simulator; `nsh test` runs on it
// headless. Keep it honest: the sections are typed by @eta/client-contracts and the ops are
// answered the way apps/eta answers them.
//
// Each feature adds its data and ops in `fixtures/<feature>.ts`.

import type { MountedPlugin, ServerFrame } from "@eta/client-contracts";
import type { ClientFrame, ErrorProblem } from "@eta/client-wire-proto";
import type { RefusedBy, WireSocket } from "../wire/wire";
import { Storage } from "nsh";
import { useSocketFactory } from "../app/session";
import { installBase } from "./fixtures/base";
import { installChat } from "./fixtures/chat";
import { installConnect } from "./fixtures/connect";
import { installConversations } from "./fixtures/conversations";
import { installCreate } from "./fixtures/create";
import { installGroup } from "./fixtures/group";
import { installInbox } from "./fixtures/inbox";
import { installTasks } from "./fixtures/tasks";

export type Op = (args: any) => unknown;

/** `eta.fake.refuse` in storage makes every attempt fail, for the connect screens. */
export const REFUSE_KEY = "eta.fake.refuse";
/** `eta.fake.scenario` picks a fixture's variant: "empty", "uninitialized", … */
export const SCENARIO_KEY = "eta.fake.scenario";

export class FakeHost {
  /** target → section → value. */
  readonly state = new Map<string, Record<string, unknown>>();
  readonly eager = new Set<string>();
  readonly ops = new Map<string, Op>();
  scenario = "";
  /** `hello.mounted`: the plugins this host has. */
  mounted: MountedPlugin[] = [];
  private revision = 0;
  private versions = new Map<string, number>();
  private subscribers = new Set<string>();
  private receiver: ((text: string) => void) | undefined;

  /** Give a target its sections; `eager` ones go out with `hello`. */
  set(target: string, sections: Record<string, unknown>, options: { eager?: boolean } = {}): void {
    this.state.set(target, sections);
    if (options.eager) this.eager.add(target);
    this.push(target);
  }

  /** Change one section and tell whoever watches. */
  patch(target: string, section: string, value: unknown): void {
    const sections = this.state.get(target) ?? {};
    sections[section] = value;
    this.state.set(target, sections);
    this.push(target);
  }

  section<T>(target: string, section: string): T {
    return this.state.get(target)?.[section] as T;
  }

  on(op: string, handler: Op): void {
    this.ops.set(op, handler);
  }

  event(target: string, name: string, data: unknown): void {
    this.emit({ type: "event", target, name, data, at: Date.now() });
  }

  private snapshot(target: string) {
    const sections = this.state.get(target) ?? {};
    this.revision += 1;
    const revisions = Object.fromEntries(
      Object.keys(sections).map((name) => [name, `r${this.revision}`]),
    );
    return { sections, revisions };
  }

  private push(target: string): void {
    if (!this.subscribers.has(target)) return;
    const version = (this.versions.get(target) ?? 0) + 1;
    this.versions.set(target, version);
    this.emit({ type: "state", target, version, snapshot: this.snapshot(target) });
  }

  private emit(frame: ServerFrame): void {
    const send = this.receiver;
    if (send !== undefined) setTimeout(() => send(JSON.stringify(frame)), 0);
  }

  private async handle(frame: ClientFrame): Promise<void> {
    if (frame.op === "subscribe") {
      this.subscribers.add(frame.target);
      if (this.state.has(frame.target)) this.push(frame.target);
      else this.emit({ type: "event", target: frame.target, name: "target:missing", data: null });
      return;
    }
    if (frame.op === "unsubscribe") {
      this.subscribers.delete(frame.target);
      return;
    }
    if (frame.op !== "call" || frame.requestId === undefined) return;
    const name = `${frame.target.split(".")[0]}.${frame.action}`;
    const handler = this.ops.get(name);
    try {
      if (handler === undefined) throw new Error(`unknown op: ${name}`);
      const result = await handler({ ...(frame.args as object), target: frame.target });
      this.emit({ type: "reply", requestId: frame.requestId, ok: true, result });
    } catch (error) {
      this.emit({
        type: "reply",
        requestId: frame.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        problem: (error as { problem?: ErrorProblem }).problem,
      });
    }
  }

  socket(refused: RefusedBy | undefined): WireSocket {
    let onClose: (why?: RefusedBy) => void = () => undefined;
    if (refused !== undefined) setTimeout(() => onClose(refused), 200);
    else {
      setTimeout(() => {
        const ops = [...this.ops.keys()].map((name) => {
          const [target = "", action = ""] = name.split(".");
          return { name, target, action };
        });
        const state = Object.fromEntries([...this.eager].map((t) => [t, this.snapshot(t)]));
        this.emit({ type: "hello", ops, mounted: this.mounted, state });
      }, 0);
    }
    return {
      send: (text) => void this.handle(JSON.parse(text) as ClientFrame),
      close: () => {
        this.receiver = undefined;
        this.subscribers.clear();
      },
      onMessage: (listener) => {
        this.receiver = listener;
      },
      onClose: (listener) => {
        onClose = listener;
      },
    };
  }
}

export const fake = new FakeHost();

export function installFixtures(host: FakeHost): void {
  installBase(host);
  installConnect(host);
  installInbox(host);
  installConversations(host);
  installChat(host);
  installGroup(host);
  installTasks(host);
  installCreate(host);
}

/** Run on the fake host, and start on it: nothing to type in the connect form. */
export function useFakeHost(): void {
  useSocketFactory(() => {
    throw new Error("the fake host is not ready");
  });
  const started = (async () => {
    fake.scenario = (await Storage.getItem(SCENARIO_KEY)) ?? "";
    installFixtures(fake);
    return (await Storage.getItem(REFUSE_KEY)) as RefusedBy | null;
  })();
  useSocketFactory(() => {
    let inner: WireSocket | undefined;
    let message: ((text: string) => void) | undefined;
    let close: ((why?: RefusedBy) => void) | undefined;
    void started.then((refused) => {
      inner = fake.socket(refused ?? undefined);
      if (message) inner.onMessage(message);
      if (close) inner.onClose(close);
    });
    return {
      send: (text) => inner?.send(text),
      close: () => inner?.close(),
      onMessage: (listener) => {
        message = listener;
        inner?.onMessage(listener);
      },
      onClose: (listener) => {
        close = listener;
        inner?.onClose(listener);
      },
    };
  });
}
