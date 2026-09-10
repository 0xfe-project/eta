import { Show, createContext, createSignal, onCleanup, splitProps, useContext, type JSX } from "solid-js";
import { cn } from "../../lib/utils";

interface MenuCtx {
	open: () => boolean;
	setOpen: (open: boolean) => void;
}

const MenuContext = createContext<MenuCtx>();

export function DropdownMenu(props: { children: JSX.Element }) {
	const [open, setOpen] = createSignal(false);
	return <MenuContext.Provider value={{ open, setOpen }}>{props.children}</MenuContext.Provider>;
}

export function DropdownMenuTrigger(props: { children: JSX.Element }) {
	const menu = useContext(MenuContext);
	if (menu === undefined) throw new Error("DropdownMenuTrigger outside DropdownMenu");
	return (
		<span
			onClick={(event) => {
				event.stopPropagation();
				menu.setOpen(!menu.open());
			}}
		>
			{props.children}
		</span>
	);
}

export function DropdownMenuContent(props: { class?: string; className?: string; align?: string; children?: JSX.Element; "data-testid"?: string }) {
	const menu = useContext(MenuContext);
	if (menu === undefined) throw new Error("DropdownMenuContent outside DropdownMenu");
	const onDoc = (event: MouseEvent) => {
		const target = event.target as Node | null;
		if (target !== null && event.currentTarget instanceof Node) return;
		menu.setOpen(false);
	};
	document.addEventListener("click", onDoc);
	onCleanup(() => document.removeEventListener("click", onDoc));
	return (
		<Show when={menu.open()}>
			<div
				data-testid={props["data-testid"]}
				class={cn(
					"z-50 min-w-[160px] border-2 border-border-strong bg-popover text-popover-foreground shadow-[4px_4px_0_0_var(--shadow)]",
					props.class,
					props.className,
				)}
			>
				{props.children}
			</div>
		</Show>
	);
}

export function DropdownMenuItem(props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { class?: string; className?: string }) {
	const menu = useContext(MenuContext);
	const [local, rest] = splitProps(props, ["class", "className", "onClick"]);
	return (
		<button
			type="button"
			class={cn(
				"flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] outline-none select-none hover:bg-primary hover:text-primary-foreground disabled:opacity-40",
				local.class,
				local.className,
			)}
			onClick={(event) => {
				if (typeof local.onClick === "function") local.onClick(event);
				menu?.setOpen(false);
			}}
			{...rest}
		/>
	);
}

export function DropdownMenuSeparator() {
	return <div class="my-1 h-px bg-border" />;
}
