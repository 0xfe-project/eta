import { Show, createContext, createEffect, createSignal, createUniqueId, on, onCleanup, onMount, splitProps, useContext, type JSX } from "solid-js";
import { cn } from "../../lib/utils";
import { createPresence } from "../../lib/presence.ts";

interface MenuCtx {
	id: string;
	open: () => boolean;
	setOpen: (open: boolean) => void;
	trigger: () => HTMLButtonElement | undefined;
	setTrigger: (element: HTMLButtonElement) => void;
	focusLast: boolean;
	close: (restoreFocus?: boolean) => void;
}
const MenuContext = createContext<MenuCtx>();

export function DropdownMenu(props: { children: JSX.Element }) {
	const [open, setOpen] = createSignal(false);
	const [trigger, setTrigger] = createSignal<HTMLButtonElement>();
	const menu: MenuCtx = {
		id: createUniqueId(), open, setOpen, trigger, setTrigger,
		focusLast: false,
		close(restoreFocus = false) { setOpen(false); if (restoreFocus) trigger()?.focus(); },
	};
	return <MenuContext.Provider value={menu}><div class="relative min-w-0">{props.children}</div></MenuContext.Provider>;
}

export function DropdownMenuTrigger(props: JSX.ButtonHTMLAttributes<HTMLButtonElement>) {
	const menu = useContext(MenuContext);
	if (!menu) throw new Error("DropdownMenuTrigger outside DropdownMenu");
	return <button
		{...props}
		ref={element => menu.setTrigger(element)}
		type="button"
		id={`${menu.id}-trigger`}
		aria-haspopup="menu"
		aria-expanded={menu.open()}
		aria-controls={menu.open() ? menu.id : undefined}
		onClick={event => { event.stopPropagation(); menu.focusLast = false; menu.setOpen(!menu.open()); }}
		onKeyDown={event => {
			if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
			event.preventDefault(); event.stopPropagation();
			menu.focusLast = event.key === "ArrowUp";
			menu.setOpen(true);
		}}
	/>;
}

interface ContentProps {
	class?: string;
	className?: string;
	align?: "start" | "end";
	side?: "top" | "bottom";
	children?: JSX.Element;
	/** Set by DropdownMenuContent while the panel plays its exit animation. */
	closing?: boolean;
	"data-testid"?: string;
}

export function DropdownMenuContent(props: ContentProps) {
	const menu = useContext(MenuContext)!;
	const presence = createPresence(() => menu.open());
	return <Show when={presence.mounted()}><MenuPopup {...props} closing={presence.closing()} /></Show>;
}

function MenuPopup(props: ContentProps) {
	const menu = useContext(MenuContext)!;
	let content!: HTMLDivElement;
	const items = () => [...content.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]:not(:disabled)')];
	/** Focus follows every open rather than every mount: a panel closed and reopened
	 * inside the exit animation is still mounted, and the second open still has to move
	 * focus into it. */
	createEffect(on(() => menu.open(), (open) => {
		if (!open) return;
		const available = items();
		(menu.focusLast ? available.at(-1) : available[0])?.focus();
		if (available.length === 0) content.focus();
	}));
	onMount(() => {
		const outside = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (target && !content.contains(target) && !menu.trigger()?.contains(target)) menu.close();
		};
		document.addEventListener("pointerdown", outside, true);
		onCleanup(() => {
			document.removeEventListener("pointerdown", outside, true);
		});
	});
	return <div ref={content} id={menu.id} role="menu" aria-labelledby={`${menu.id}-trigger`} tabindex="-1"
		data-testid={props["data-testid"]} data-side={props.side ?? "top"} data-state={props.closing === true ? "closed" : "open"}
		class={cn("popover-panel", props.side === "bottom" ? "top-[calc(100%+6px)]" : "bottom-[calc(100%+6px)]", props.align === "end" ? "right-0" : "left-0", "absolute w-max min-w-[180px] max-w-[min(300px,70vw)] max-h-[min(320px,50vh)] z-50 overflow-y-auto overscroll-contain border border-overlay-hover bg-popover text-popover-foreground shadow-[4px_4px_0_0_var(--shadow)]", props.class, props.className)}
		onKeyDown={event => {
			event.stopPropagation();
			if (event.key === "Escape") { event.preventDefault(); menu.close(true); return; }
			if (event.key === "Tab") { menu.close(true); return; }
			if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
			event.preventDefault();
			const available = items();
			const current = available.indexOf(document.activeElement as HTMLButtonElement);
			const index = event.key === "Home" ? 0 : event.key === "End" ? available.length - 1
				: (current + (event.key === "ArrowDown" ? 1 : -1) + available.length) % available.length;
			available[index]?.focus();
		}}>{props.children}</div>;
}

export function DropdownMenuItem(props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { className?: string }) {
	const menu = useContext(MenuContext);
	const [local, rest] = splitProps(props, ["class", "className", "onClick"]);
	return <button {...rest} type="button" role={props.role ?? "menuitem"}
		class={cn("flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] whitespace-normal break-words select-none hover:bg-overlay-hover hover:text-foreground focus-visible:bg-overlay-hover focus-visible:text-foreground disabled:opacity-40", local.class, local.className)}
		onClick={event => { if (typeof local.onClick === "function") local.onClick(event); menu?.close(true); }} />;
}

export function DropdownMenuChevron() {
	return <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 15 6-6 6 6" /></svg>;
}

export function DropdownMenuSeparator() { return <div class="my-1 h-px bg-border" />; }
