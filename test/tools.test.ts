import { Context } from "cordis";
import { describe, expect, it } from "vitest";
import { type KernelTool, ToolService } from "../src/kernel/tools";

function withTools() {
	const ctx = new Context();
	const tools = new ToolService(ctx);
	return {
		tools,
		dispose: () => void ctx.fiber.dispose(),
	};
}

const echo: KernelTool<string, string> = {
	name: "echo",
	execute: (args) => `echo:${args}`,
};

describe("tool service", () => {
	it("registers, lists, and unregisters; unregister returns whether it removed something", () => {
		const { tools, dispose } = withTools();
		expect(tools.names()).toEqual([]);
		const off = tools.register(echo);
		expect(tools.names()).toEqual(["echo"]);
		expect(tools.get("echo")).toBe(echo);
		off();
		expect(tools.names()).toEqual([]);
		expect(tools.unregister("echo")).toBe(false);
		dispose();
	});

	it("a returned unregister closure does not clobber a re-registered tool", () => {
		const { tools, dispose } = withTools();
		const offA = tools.register(echo);
		const replacement: KernelTool = { name: "echo", execute: () => "v2" };
		tools.register(replacement);
		offA();
		expect(tools.get("echo")).toBe(replacement);
		dispose();
	});

	it("hot registration: a tool added mid-session is in the very next list()", async () => {
		const { tools, dispose } = withTools();
		const call = { turn: 1, toolCallId: "c1" };
		const before = await tools.execute("echo", "x", call);
		expect(before).toMatchObject({ isError: true, content: "unknown tool: echo" });
		tools.register(echo);
		const after = await tools.execute("echo", "x", call);
		expect(after).toBe("echo:x");
		dispose();
	});

	it("middleware before can rewrite args; after can rewrite the result", async () => {
		const { tools, dispose } = withTools();
		tools.register(echo);
		const detach = tools.use({
			name: "rewrite",
			before: (_name, args) => ({ ok: true, args: `[${args}]` }),
			after: (_name, _args, result) => `<${result}>`,
		});
		const out = await tools.execute("echo", "x", { turn: 1, toolCallId: "c1" });
		expect(out).toBe("<echo:[x]>");
		detach();
		const plain = await tools.execute("echo", "x", { turn: 1, toolCallId: "c2" });
		expect(plain).toBe("echo:x");
		dispose();
	});

	it("middleware before can block a call and the tool never runs", async () => {
		const { tools, dispose } = withTools();
		let ran = false;
		tools.register({
			name: "danger",
			execute: () => {
				ran = true;
				return "ran";
			},
		});
		tools.use({ name: "gate", before: () => ({ ok: false, blockReason: "not today" }) });
		const out = await tools.execute("danger", {}, { turn: 1, toolCallId: "c1" });
		expect(out).toMatchObject({ isError: true, content: "blocked by gate: not today" });
		expect(ran).toBe(false);
		dispose();
	});

	it("middleware ordering: before runs outer→inner, after runs inner→outer", async () => {
		const { tools, dispose } = withTools();
		const order: string[] = [];
		tools.register({ name: "t", execute: () => order.push("tool") });
		tools.use({
			name: "outer",
			before: () => {
				order.push("outer:before");
				return { ok: true, args: {} };
			},
			after: () => {
				order.push("outer:after");
			},
		});
		tools.use({
			name: "inner",
			before: () => {
				order.push("inner:before");
				return { ok: true, args: {} };
			},
			after: () => {
				order.push("inner:after");
			},
		});
		await tools.execute("t", {}, { turn: 1, toolCallId: "c1" });
		expect(order).toEqual(["outer:before", "inner:before", "tool", "inner:after", "outer:after"]);
		dispose();
	});

	it("a detached middleware stops participating", async () => {
		const { tools, dispose } = withTools();
		tools.register(echo);
		const detach = tools.use({ name: "spy", after: (_n, _a, r) => `${r}!` });
		expect(await tools.execute("echo", "x", { turn: 1, toolCallId: "c1" })).toBe("echo:x!");
		detach();
		expect(await tools.execute("echo", "x", { turn: 1, toolCallId: "c2" })).toBe("echo:x");
		dispose();
	});
});
