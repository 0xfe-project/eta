/** Client business vocabulary. No server, kernel, harness or SDK dependencies. */
import type {
  StatePatch,
  StateSnapshot,
  HelloFrame as WireHelloFrame,
  ServerFrame as WireServerFrame,
} from "@eta/client-wire-proto";
import type {
  MountedPlugin,
  SessionViewSections,
  ViewDiagnostics,
} from "./types";

export * from "./acp";
export * from "./acp-form";
export * from "./artifacts";
export * from "./captain";
export * from "./context-usage";
export type * from "./data";
export * from "./host-launcher";
export * from "./inbox";
export * from "./link";
export * from "./llm";
export * from "./mcp";
export * from "./memory";
export * from "./operations";
export * from "./places";
export type * from "./plugin-fields";
export * from "./plugins";
export * from "./product";
export * from "./providers";
export * from "./routines";
export * from "./run";
export * from "./skill-files";
export * from "./system-notice";
export * from "./task-order";
export * from "./tasks";
export * from "./thinking";
export type * from "./types";
export { SERVICE_PROTOCOL } from "./types";
export * from "./usage";

/** The existing hello payload, specialized without coupling the pipe to business types. */
export type HelloFrame = WireHelloFrame<MountedPlugin, ViewDiagnostics>;
export type ServerFrame = Exclude<WireServerFrame, WireHelloFrame> | HelloFrame;

/** Read one section with its type, admitting that it may be absent. */
export function stateSection<K extends keyof SessionViewSections>(
  state: StateSnapshot | StatePatch,
  name: K,
): SessionViewSections[K] | undefined {
  const sections: Record<string, unknown> = { ...state.sections };
  return sections[name as string] as SessionViewSections[K] | undefined;
}
