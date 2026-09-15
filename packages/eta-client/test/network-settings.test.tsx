// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { NetworkSettings } from "../src/features/settings/network-settings.tsx";
import { render, click, setField } from "./render.tsx";
import { byId } from "./dom.ts";

it("loads system mode, saves manual proxy and tells the user to restart", async () => {
	const writes: any[] = [];
	const dirty = vi.fn();
	vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
		if (init?.method === "POST") { const body = JSON.parse(String(init.body)); writes.push(body); return Response.json({ revision: "two", network: body.network }); }
		return Response.json({ revision: "one", network: { mode: "system" }, runtime: { source: "system" } });
	}));
	const page = render(<NetworkSettings onDirtyChange={dirty} onBusyChange={() => {}} />);
	await vi.waitFor(() => expect((byId("network-mode").closest("fieldset") as HTMLFieldSetElement).disabled).toBe(false));
	setField("network-mode", "manual");
	setField("network-url", "http://127.0.0.1:1082");
	setField("network-bypass", ".internal");
	expect(dirty).toHaveBeenLastCalledWith(true);
	click("network-save");
	await vi.waitFor(() => expect(writes).toHaveLength(1));
	expect(writes[0]).toEqual({ revision: "one", network: { mode: "manual", proxyUrl: "http://127.0.0.1:1082", noProxy: ".internal" } });
	await vi.waitFor(() => expect(page.getByRole("status").textContent).toMatch(/已保存|Saved/));
	expect(dirty).toHaveBeenLastCalledWith(false);
	setField("network-mode", "direct");
	expect(page.queryByTestId("network-url")).toBeNull();
});
