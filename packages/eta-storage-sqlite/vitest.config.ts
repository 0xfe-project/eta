import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const agentTesting = fileURLToPath(new URL("../eta-core/src/harness/session/testing/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
	},
	resolve: {
		alias: [
			{ find: /^@eta\/core\/testing$/, replacement: agentTesting },
			{ find: /^@eta\/core\/node$/, replacement: fileURLToPath(new URL("../eta-core/src/node.ts", import.meta.url)) },
		],
	},
});
