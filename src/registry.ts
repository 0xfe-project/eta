/**
 * The op registry: ops are registered, not switched (SERVER-REFACTOR.md §3).
 *
 * The floor's own modules register their ops at startup (`handle("session.pin", …)`),
 * and a plugin registers through `handlePlugin(name, action, …)` — the registry owns the
 * namespace, so a plugin's actions are reachable only as `plugin.call {plugin, action}`
 * and can never collide with a built-in op or with another plugin's.
 *
 * Three consequences worth naming, because each one is a bug the switch-table version
 * had:
 *
 * - **Adding an op does not touch the router.** A plugin that adds `git.status` needs a
 *   registry entry, not a branch in a dispatch function that every other plugin shares.
 * - **An unknown op is an error, not a no-op.** The client is told which op it sent that
 *   nobody claimed; silence is how a typo becomes "the button does nothing".
 * - **Unloading a plugin removes exactly its ops.** Every registration returns a
 *   disposer, so a plugin's failure or removal takes its routes with it while its
 *   neighbours keep working.
 */
import type { ClientMessage, GuiOp, PluginOp } from "@eta/wire";
import type { DispatchOutcome, Socket } from "./transport";

/** What a handler is given besides the op itself. */
export interface OpContext {
	/** The socket that asked: a resync answers it alone, a subscribe belongs to it. */
	readonly socket: Socket;
	/** Send a frame to that socket (the handler's own answer, if it has one). */
	reply(message: import("@eta/wire").ServerMessage): void;
}

/** One registered op: what it is called, and who owns it. */
export interface OpRegistration {
	/** The wire spelling: a built-in's op name, or `plugin.<name>.<action>` for a plugin. */
	name: string;
	/** The plugin that owns it, when a plugin does. */
	plugin?: string | undefined;
}

export type OpHandler = (op: never, context: OpContext) => Promise<DispatchOutcome> | DispatchOutcome;

export interface OpRegistry {
	/** Register one of the floor's own ops. Duplicate names are refused. */
	handle(op: GuiOp["op"] | PluginOp["op"], handler: OpHandler): () => void;
	/** Register a plugin's action; the registry owns the namespace and the prefix. */
	handlePlugin(plugin: string, action: string, handler: OpHandler): () => void;
	/** Route one message. Throws `UnknownOpError` when nobody claims it. */
	dispatch(message: ClientMessage, context: OpContext): Promise<DispatchOutcome>;
	/** Every registered op name, built-ins and plugin actions alike (for `hello`/dev). */
	names(): string[];
	/** The actions one plugin registered. */
	pluginNames(plugin: string): string[];
	/** How many ops a plugin still owns (the manager checks nothing was left behind). */
	pluginSize(plugin: string): number;
}

/** The error a client gets when it asks for an op nobody registered. */
export class UnknownOpError extends Error {
	readonly op: string;
	constructor(op: string) {
		super(`unknown op: ${op}`);
		this.name = "UnknownOpError";
		this.op = op;
	}
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

export interface OpRegistryOptions {
	warn?: ((message: string) => void) | undefined;
}

export function createOpRegistry(options: OpRegistryOptions = {}): OpRegistry {
	const builtins = new Map<string, OpHandler>();
	const plugins = new Map<string, Map<string, OpHandler>>();
	const _warn = options.warn ?? (() => undefined);

	const claimName = (name: string): void => {
		if (!NAME_PATTERN.test(name)) throw new Error(`invalid op name: ${JSON.stringify(name)}`);
		if (builtins.has(name)) throw new Error(`op already registered: ${name}`);
	};

	return {
		handle(op, handler): () => void {
			claimName(op);
			builtins.set(op, handler as OpHandler);
			return () => {
				if (builtins.get(op) === (handler as OpHandler)) builtins.delete(op);
			};
		},

		handlePlugin(plugin, action, handler): () => void {
			if (!NAME_PATTERN.test(plugin)) throw new Error(`invalid plugin name: ${JSON.stringify(plugin)}`);
			if (!NAME_PATTERN.test(action)) {
				throw new Error(`invalid action for plugin ${plugin}: ${JSON.stringify(action)}`);
			}
			const owned = plugins.get(plugin) ?? new Map<string, OpHandler>();
			if (owned.has(action)) throw new Error(`plugin ${plugin} already registered ${action}`);
			owned.set(action, handler as OpHandler);
			plugins.set(plugin, owned);
			return () => {
				if (owned.get(action) === (handler as OpHandler)) owned.delete(action);
				if (owned.size === 0) plugins.delete(plugin);
			};
		},

		async dispatch(message: ClientMessage, context: OpContext): Promise<DispatchOutcome> {
			if (message.op === "plugin.call") {
				const owned = plugins.get(message.plugin);
				const handler = owned?.get(message.action);
				if (handler === undefined) {
					throw new UnknownOpError(`plugin.${message.plugin}.${message.action}`);
				}
				return await handler(message as never, context);
			}
			if (message.op === "plugin.subscribe" || message.op === "plugin.unsubscribe") {
				// Subscription is the wire's own facility: the manager installs one handler
				// for both, and a plugin that needs anything else registers an action.
				const handler = builtins.get(message.op);
				if (handler === undefined) throw new UnknownOpError(message.op);
				return await handler(message as never, context);
			}
			const handler = builtins.get(message.op);
			if (handler === undefined) throw new UnknownOpError(message.op);
			return await handler(message as never, context);
		},

		names(): string[] {
			return [
				...builtins.keys(),
				...[...plugins].flatMap(([plugin, actions]) =>
					[...actions.keys()].map((action) => `plugin.${plugin}.${action}`),
				),
			].sort();
		},

		pluginNames(plugin): string[] {
			return [...(plugins.get(plugin)?.keys() ?? [])].sort();
		},

		pluginSize(plugin): number {
			return plugins.get(plugin)?.size ?? 0;
		},
	};
}
