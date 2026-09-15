import { createSignal } from "solid-js";

/**
 * The btw dialog is raised from two places — `/btw` in the composer and a thread
 * row in the context panel — and is rendered by neither of them. A shared signal
 * is what makes `/btw` pop the dialog even with the right-hand panel closed.
 */
export const [btwDialogOpen, setBtwDialogOpen] = createSignal(false);
