/**
 * The local Electrobun CLI pins the SDK and projects it into
 * .hutch/devkit, which is where the main process gets its `electrobun/main` types.
 */
export default {
	scripts: {
		start: "bun run prepare:app && bun x --bun electrobun prepare && bun x --bun electrobun dev --env=dev",
	},
	electrobun: {
		version: "2.0.1",
	},
};
