/**
 * Hutch pins the Electrobun SDK; `hutch electrobun prepare` projects it into
 * .hutch/devkit, which is where the main process gets its `electrobun/main` types.
 */
export default {
	scripts: {
		start: "hutch electrobun prepare && hutch electrobun dev --env=dev",
	},
	electrobun: {
		version: "2.0.1",
	},
};
