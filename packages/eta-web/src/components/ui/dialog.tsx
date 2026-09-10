import { Show, createContext, splitProps, useContext, type JSX } from "solid-js";
import { cn } from "../../lib/utils";

interface DialogCtx {
	onOpenChange?: (open: boolean) => void;
}

const DialogContext = createContext<DialogCtx>({});

export function Dialog(props: { open?: boolean; onOpenChange?: (open: boolean) => void; children: JSX.Element }) {
	return (
		<Show when={props.open}>
			<DialogContext.Provider value={{ onOpenChange: props.onOpenChange }}>{props.children}</DialogContext.Provider>
		</Show>
	);
}

export function DialogContent(props: { class?: string; className?: string; hideClose?: boolean; children?: JSX.Element; "data-testid"?: string }) {
	const dialog = useContext(DialogContext);
	const [local, rest] = splitProps(props, ["class", "className", "hideClose", "children"]);
	const close = () => dialog.onOpenChange?.(false);
	return (
		<>
			<div class="fixed inset-0 z-50 bg-[var(--backdrop)]" onClick={close} />
			<div
				class={cn(
					"fixed top-1/2 left-1/2 z-50 flex max-h-[82vh] w-full max-w-[640px] -translate-x-1/2 -translate-y-1/2 flex-col border-2 border-border-strong bg-popover text-popover-foreground shadow-[6px_6px_0_0_var(--shadow)] focus:outline-none",
					local.class,
					local.className,
				)}
				{...rest}
			>
				{local.children}
				<Show when={!local.hideClose}>
					<button
						type="button"
						class="absolute top-2 right-2 cursor-pointer p-1 text-muted hover:bg-primary hover:text-primary-foreground"
						aria-label="Close"
						onClick={close}
					>
						<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-3.5">
							<path d="M18 6 6 18" />
							<path d="m6 6 12 12" />
						</svg>
					</button>
				</Show>
			</div>
		</>
	);
}

export function DialogHeader(props: { class?: string; className?: string; children?: JSX.Element }) {
	return (
		<div class={cn("flex items-center gap-2 border-b border-border px-3 py-2 font-mono text-[12px] tracking-[0.12em] uppercase", props.class, props.className)}>
			{props.children}
		</div>
	);
}

export function DialogBody(props: { class?: string; className?: string; children?: JSX.Element }) {
	return <div class={cn("min-h-0 flex-1 overflow-y-auto", props.class, props.className)}>{props.children}</div>;
}

export function DialogFooter(props: { class?: string; className?: string; children?: JSX.Element }) {
	return <div class={cn("flex items-center justify-end gap-2 border-t border-border px-3 py-2", props.class, props.className)}>{props.children}</div>;
}

export function DialogTitle(props: { class?: string; className?: string; children?: JSX.Element; "data-testid"?: string }) {
	return (
		<h2 data-testid={props["data-testid"]} class={cn("min-w-0 flex-1", props.class, props.className)}>
			{props.children}
		</h2>
	);
}
