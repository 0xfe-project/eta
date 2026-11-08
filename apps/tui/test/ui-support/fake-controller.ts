/**
 * A connection controller the test drives by hand: it records every action and moves to a phase
 * only when the test says so.
 */
import type { UpgradeBusy } from "@eta/client-contracts";
import type {
  AddressCheck,
  ConnectionController,
  ConnectionPhase,
  ConnectionState,
} from "../../src/connection/types";
import { fakeWire } from "./fake-wire";

export class FakeController implements ConnectionController {
  private state: ConnectionState;
  private readonly listeners = new Set<() => void>();
  readonly calls: string[] = [];
  checkAddressResult: (url: string, token?: string) => AddressCheck = (
    url,
  ) => ({ result: "ok", url });

  busy: UpgradeBusy[] | undefined = [];
  /** When set, `handover` rejects with it, as the real one does when the host is not temporary. */
  handoverError: Error | undefined;

  constructor(phase: ConnectionPhase, patch: Partial<ConnectionState> = {}) {
    this.state = {
      phase,
      wire: fakeWire(),
      setting: undefined,
      tokenFromEnv: false,
      versionWarning: undefined,
      saveProblem: undefined,
      ...patch,
    };
  }

  setPhase(phase: ConnectionPhase): void {
    this.patch({ phase });
  }

  patch(patch: Partial<ConnectionState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  getState = (): ConnectionState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start = async (): Promise<void> => {
    this.calls.push("start");
  };

  checkAddress = async (url: string, token?: string): Promise<AddressCheck> => {
    this.calls.push(
      token === undefined
        ? `checkAddress ${url}`
        : `checkAddress ${url} ${token}`,
    );
    return this.checkAddressResult(url, token);
  };

  connectResident = async (input: {
    url: string;
    token?: string;
  }): Promise<void> => {
    this.calls.push(
      input.token === undefined
        ? `connectResident ${input.url}`
        : `connectResident ${input.url} ${input.token}`,
    );
  };

  startTemporary = async (options: { persist: boolean }): Promise<void> => {
    this.calls.push(`startTemporary persist=${options.persist}`);
  };

  installResident = async (): Promise<void> => {
    this.calls.push("installResident");
  };

  handoverBusy = async (): Promise<UpgradeBusy[] | undefined> => {
    this.calls.push("handoverBusy");
    return this.busy;
  };

  handover = async (): Promise<void> => {
    this.calls.push("handover");
    if (this.handoverError) throw this.handoverError;
  };

  dismissFailure = async (): Promise<void> => {
    this.calls.push("dismissFailure");
  };

  stop = async (): Promise<void> => {
    this.calls.push("stop");
  };
}
