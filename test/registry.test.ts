/**
 * The op registry (S10).
 *
 * The subject is the namespace: who may claim an op name, what happens when nobody
 * does, and what a plugin's unload leaves behind. Every one of these is a rule the
 * switch-table version could only express by remembering to.
 */

import type { ClientMessage } from "@eta/wire";
import { describe, expect, it } from "vitest";
import { createOpRegistry, UnknownOpError } from "../src/registry";
import type { Socket } from "../src/transport";

const socket: Socket = { id: 1, send: () => undefined };
const context = { socket, reply: () => undefined };

const registryWith = () => {
	const registry = createOpRegistry({ warn: () => undefined });
	return { registry, context };
};

describe("built-in ops", () => {
	it("routes a registered op to its handler", async () => {
		const { registry, context } = registryWith();
		const seen: string[] = [];
		registry.handle("focus", (op) => {
			seen.push((op as { session: string }).session);
			return {};
		});
		await registry.dispatch({ op: "focus", session: "s1" }, context);
		expect(seen).toEqual(["s1"]);
	});

	it("refuses a duplicate op name", () => {
		const { registry } = registryWith();
		registry.handle("prompt", () => ({}));
		expect(() => registry.handle("prompt", () => ({}))).toThrow(/already registered/);
	});

	it("calls an unclaimed op an error naming the op", async () => {
		const { registry, context } = registryWith();
		await expect(registry.dispatch({ op: "compact", session: "s1" }, context)).rejects.toThrow(UnknownOpError);
		await expect(registry.dispatch({ op: "compact", session: "s1" }, context)).rejects.toThrow(/unknown op: compact/);
	});

	it("forgets an op when its disposer runs", async () => {
		const { registry, context } = registryWith();
		const off = registry.handle("focus", () => ({}));
		off();
		await expect(registry.dispatch({ op: "focus", session: "s1" }, context)).rejects.toThrow(UnknownOpError);
	});
});

describe("plugin ops", () => {
	it("addresses an action through plugin.call, and never as a bare op", async () => {
		const { registry, context } = registryWith();
		const seen: unknown[] = [];
		registry.handlePlugin("git", "status", (op) => {
			seen.push((op as { args?: unknown }).args);
			return { broadcast: { channel: "plugin", plugin: "git", action: "status", data: { branch: "main" } } };
		});
		const outcome = await registry.dispatch(
			{ op: "plugin.call", plugin: "git", action: "status", args: { path: "/w" } },
			context,
		);
		expect(seen).toEqual([{ path: "/w" }]);
		expect(outcome.broadcast).toMatchObject({ channel: "plugin", plugin: "git", action: "status" });
		// The action name itself is not an op anybody can send.
		await expect(registry.dispatch({ op: "status" } as unknown as ClientMessage, context)).rejects.toThrow(
			/unknown op: status/,
		);
	});

	it("tells the client which plugin and action nobody claimed", async () => {
		const { registry, context } = registryWith();
		registry.handlePlugin("git", "status", () => ({}));
		await expect(
			registry.dispatch({ op: "plugin.call", plugin: "git", action: "diff", args: {} }, context),
		).rejects.toThrow(/unknown op: plugin.git.diff/);
		await expect(registry.dispatch({ op: "plugin.call", plugin: "nope", action: "x" }, context)).rejects.toThrow(
			/unknown op: plugin.nope.x/,
		);
	});

	it("keeps two plugins with the same action apart", async () => {
		const { registry, context } = registryWith();
		const seen: string[] = [];
		registry.handlePlugin("git", "refresh", () => {
			seen.push("git");
			return {};
		});
		registry.handlePlugin("ssh", "refresh", () => {
			seen.push("ssh");
			return {};
		});
		await registry.dispatch({ op: "plugin.call", plugin: "ssh", action: "refresh" }, context);
		await registry.dispatch({ op: "plugin.call", plugin: "git", action: "refresh" }, context);
		expect(seen).toEqual(["ssh", "git"]);
	});

	it("refuses a duplicate action for the same plugin, and a bad name", () => {
		const { registry } = registryWith();
		registry.handlePlugin("git", "status", () => ({}));
		expect(() => registry.handlePlugin("git", "status", () => ({}))).toThrow(/already registered status/);
		expect(() => registry.handlePlugin("git", "not an action", () => ({}))).toThrow(/invalid action/);
		expect(() => registry.handlePlugin("bad name", "x", () => ({}))).toThrow(/invalid plugin name/);
	});

	it("unloads exactly one plugin's ops", async () => {
		const { registry, context } = registryWith();
		const offGit = registry.handlePlugin("git", "status", () => ({}));
		registry.handlePlugin("ssh", "hosts", () => ({}));
		expect(registry.pluginNames("git")).toEqual(["status"]);
		expect(registry.pluginSize("git")).toBe(1);

		offGit();
		expect(registry.pluginNames("git")).toEqual([]);
		expect(registry.pluginSize("git")).toBe(0);
		// The neighbour is untouched, and the unloaded op is an error now.
		expect(registry.pluginNames("ssh")).toEqual(["hosts"]);
		await expect(registry.dispatch({ op: "plugin.call", plugin: "git", action: "status" }, context)).rejects.toThrow(
			UnknownOpError,
		);
	});

	it("reports every name it owns, for hello and the dev panel", () => {
		const { registry } = registryWith();
		registry.handle("focus", () => ({}));
		registry.handle("prompt", () => ({}));
		registry.handlePlugin("git", "status", () => ({}));
		expect(registry.names()).toEqual(["focus", "plugin.git.status", "prompt"]);
	});
});
