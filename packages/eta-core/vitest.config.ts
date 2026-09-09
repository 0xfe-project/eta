import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const agentSrcIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));
const aiSrcCompat = fileURLToPath(new URL("../../pi/packages/ai/src/compat.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
	},
	resolve: {
		alias: [{ find: /^@eta\/core$/, replacement: agentSrcIndex }],
	},
});
