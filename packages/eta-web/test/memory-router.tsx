import { MemoryRouter as SolidMemoryRouter, createMemoryHistory } from "@solidjs/router";
import type { JSX } from "solid-js";

/** Memory history wrapper so specs can start on `/` or `/new`. */
export function MemoryRouter(props: { initial?: string; children: JSX.Element }) {
	const history = createMemoryHistory();
	history.set({ value: props.initial ?? "/", replace: true });
	return <SolidMemoryRouter history={history}>{props.children}</SolidMemoryRouter>;
}
