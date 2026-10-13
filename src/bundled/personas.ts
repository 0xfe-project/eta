/**
 * The `personas` plugin: the cards that apply here, on the wire.
 *
 * One eager target with one section — the cards, as summaries — and two actions: read them again
 * (`reload`) and put a session on one (`set`). It also watches both persona directories, so a card
 * written by hand appears without a restart: the whole point of cards being files is that writing
 * one is the interface.
 *
 * `set` is the session-side half: it re-reads the cards for that session's directory, loads them
 * into the session, switches the active card, and writes the choice to the session's row — so a
 * restart comes back on the card the user chose, and an id nobody has is refused rather than
 * silently accepted.
 */
import { watch } from "node:fs";
import type { StateSnapshot } from "@eta/client-wire-proto";
import type { PersonaCard } from "@eta/core";
import type { ManagedSession } from "../manager";
import type { SessionManager } from "../manager";
import { discoverPersonas, resolvePersona, summarize } from "../personas";
import type { WireService } from "../wire-service";

/** The actions this target has. One list, so the wire and the plugin cannot disagree. */
export const PERSONA_ACTIONS = ["reload", "set"] as const;

export interface PersonasPluginOptions {
	manager: SessionManager;
	home: string;
	/** Diagnostics. */
	warn?: ((message: string) => void) | undefined;
}

export function personasPlugin(options: PersonasPluginOptions) {
	return {
		name: "personas",
		inject: ["wire", "sessions"],
		apply(ctx: unknown): unknown {
			const context = ctx as {
				wire: WireService;
				sessions: { open(id: string): Promise<{ managed: ManagedSession | undefined }> };
				effect(execute: () => () => unknown): unknown;
			};
			const wire = context.wire;
			return context.effect(() => {
				// The cards for the directory the client is looking at, cached so the projector can be
				// synchronous. Every read replaces it, and a push follows.
				let latest: { cwd: string; cards: PersonaCard[] } | undefined;
				const read = async (cwd: string): Promise<PersonaCard[]> => {
					const cards = await discoverPersonas({ cwd, home: options.home, warn: options.warn });
					latest = { cwd, cards: [...cards.values()] };
					return latest.cards;
				};

				// The first read populates the section; a client that connects before it lands sees an
				// empty snapshot and a push a moment later, which is the honest thing to show.
				void read(process.cwd()).then(
					() => wire.pushNow("personas"),
					(error: unknown) => options.warn?.(`[eta-server] personas: ${String(error)}`),
				);

				const registrations: (() => void)[] = [
					wire.stateOf("personas", {
						eager: true,
						project: (): StateSnapshot => {
							if (latest === undefined) return { sections: {}, revisions: {} };
							return {
								sections: { cards: summarize(new Map(latest.cards.map((card) => [card.id, card]))) },
								// The ids and their sizes: a card whose text changed is a new card.
								revisions: {
									cards: latest.cards.map((card) => `${card.id}:${card.content.length}`).join("|"),
								},
							};
						},
					}),
					wire.handle("personas", "reload", async (call) => {
						const { cwd } = (call.args ?? {}) as { cwd?: string };
						const cards = await read(cwd ?? process.cwd());
						wire.pushNow("personas");
						return { result: { cards: summarize(new Map(cards.map((card) => [card.id, card]))) } };
					}),
					wire.handle("personas", "set", async (call) => {
						const { session, persona } = (call.args ?? {}) as { session?: string; persona?: string };
						if (session === undefined || persona === undefined) {
							throw new Error("personas.set needs a session and a persona");
						}
						const { managed } = await context.sessions.open(session);
						if (managed === undefined) throw new Error(`no such session: ${session}`);
						// The cards that apply to *this* session's directory, re-read: the user may have
						// just written one.
						const cards = await discoverPersonas({
							cwd: managed.meta.cwd,
							home: options.home,
							warn: options.warn,
						});
						if (!cards.has(persona)) {
							const folded = resolvePersona(cards, persona);
							// An id nobody has is refused rather than quietly becoming the fallback: the user
							// asked for a card, and a different one is not what they asked for.
							if (!folded.exact) throw new Error(`no such persona: ${persona}`);
						}
						managed.session.kernel.persona.loadCards([...cards.values()]);
					managed.session.kernel.persona.setActive([persona]);
					await options.manager.setMeta(session, { persona });
					wire.pushNow(`sessions.${session}`);
					wire.pushNow("sessions");
					return { result: { session, persona } };
					}),
				];

				// Both directories, watched: writing a card is the interface, so it has to be enough.
				const watchers: { close(): void }[] = [];
				for (const base of [options.home, process.cwd()]) {
					try {
						const watcher = watch(`${base}/.eta/persona`, { persistent: false }, () => {
							void read(latest?.cwd ?? process.cwd()).then(() => wire.pushNow("personas"));
						});
						// A watcher is best effort: discovery runs on demand anyway, and a directory that
						// does not exist yet is not an error worth reporting.
						watcher.on("error", () => undefined);
						watchers.push(watcher);
					} catch {
						/* the directory may not exist yet */
					}
				}

				return () => {
					for (const watcher of watchers) watcher.close();
					for (const off of registrations.splice(0)) off();
				};
			});
		},
	};
}
