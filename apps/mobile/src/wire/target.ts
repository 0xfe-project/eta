import { cleanup } from "nsh";
import { wire } from "../app/session";

/**
 * Subscribe to a target for as long as the calling component lives, and read its sections.
 * The state arrives as `state` frames; nothing here fetches.
 *
 * ```ts
 * const conversation = useTarget(`conversations.${id}`);
 * const info = () => conversation.section<ConversationSections["info"]>("info");
 * ```
 */
export function useTarget(name: string) {
  const connection = wire();
  cleanup(connection.subscribe(name));
  return {
    section: <T>(section: string): T | undefined => connection.section<T>(name, section),
    /** State has arrived. */
    loaded: (): boolean => connection.target(name) !== undefined,
    /** The host says there is nothing behind the name. */
    missing: (): boolean => connection.isMissing(name),
  };
}

/** A target `hello` carries: no subscription needed to read it. */
export function eager<T>(target: string, section: string): T | undefined {
  return wire().section<T>(target, section);
}

/** `target.action`, with the current connection. */
export function call<T = unknown>(target: string, action: string, args?: unknown): Promise<T> {
  return wire().call<T>(target, action, args);
}
