import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";

/**
 * How long a panel stays mounted after it closes, once. Kept in step with the
 * `eta-unpop` animation in graphite.css: shorter and the panel is cut off mid-fade,
 * longer and the next open queues behind a panel that is already invisible.
 */
export const presenceExitMs = 90;

/**
 * Delayed unmount for panels that animate both ways.
 *
 * CSS can fade a panel in on its own, because by then the element exists. It cannot fade
 * one out: the component that owns it removes the element the moment the signal flips.
 * So the signal is split in two here — `mounted` keeps the panel in the DOM for exactly
 * one exit animation, and `closing` tells it which of the two animations to play. A panel
 * reopened inside that window skips the removal and just re-enters.
 */
export function createPresence(open: Accessor<boolean>): { mounted: Accessor<boolean>; closing: Accessor<boolean> } {
	const [mounted, setMounted] = createSignal(open());
	const [closing, setClosing] = createSignal(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	createEffect(() => {
		if (open()) {
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
			setClosing(false);
			setMounted(true);
			return;
		}
		if (!mounted()) return;
		setClosing(true);
		timer = setTimeout(() => {
			timer = undefined;
			setClosing(false);
			setMounted(false);
		}, presenceExitMs);
	});
	onCleanup(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
	return { mounted, closing };
}