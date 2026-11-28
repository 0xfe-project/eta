/** Client business vocabulary. No server, kernel, harness or SDK dependencies. */
import type {
  HelloFrame as WireHelloFrame,
  ServerFrame as WireServerFrame,
} from "@eta/client-wire-proto";
import type { MountedPlugin, ViewDiagnostics } from "./types";

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
