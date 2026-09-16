import type { ElectrobunConfig } from "electrobun";

/**
 * The front-end is not a special case here: it is the eta-client build, copied
 * verbatim into views/eta, so the shell shows the exact page a browser tab shows.
 * Everything listed under `copy` is what index.html and the CSS reach for with a
 * document-relative URL, which is also why the @font-face in index.html has no
 * leading slash.
 */
export default {
	app: {
		name: "eta",
		identifier: "dev.eta.desktop",
		version: "0.1.0",
	},
	build: {
		mainProcess: "bun",
		bun: {
			entrypoint: "src/main/index.ts",
		},
		copy: {
			"../eta-server/artifacts/desktop": "views/eta-backend",
			"../eta-client/dist/index.html": "views/eta/index.html",
			"../eta-client/dist/assets": "views/eta/assets",
			"../eta-client/dist/AKRDWGSCNFM-Regular.woff2": "views/eta/AKRDWGSCNFM-Regular.woff2",
			"../eta-client/dist/Eta-Logo.svg": "views/eta/Eta-Logo.svg",
			"../eta-client/dist/tray-16.png": "views/eta/tray-16.png",
			"../eta-client/dist/tray-18@2x.png": "views/eta/tray-18@2x.png",
		},
		mac: {
			bundleCEF: false,
			icons: "icon.iconset",
		},
	},
} satisfies ElectrobunConfig;
