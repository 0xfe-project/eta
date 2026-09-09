import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { XIcon } from "lucide-react";
import { cn } from "../../lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export const DialogContent = React.forwardRef<
	React.ComponentRef<typeof DialogPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { hideClose?: boolean }
>(({ className, children, hideClose, ...props }, ref) => (
	<DialogPrimitive.Portal>
		<DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[var(--backdrop)]" />
		<DialogPrimitive.Content
			ref={ref}
			className={cn(
				"fixed top-1/2 left-1/2 z-50 flex max-h-[82vh] w-full max-w-[640px] -translate-x-1/2 -translate-y-1/2 flex-col border-2 border-border-strong bg-popover text-popover-foreground shadow-[6px_6px_0_0_var(--shadow)] focus:outline-none",
				className,
			)}
			{...props}
		>
			{children}
			{!hideClose ? (
				<DialogPrimitive.Close className="absolute top-2 right-2 cursor-pointer p-1 text-muted hover:bg-primary hover:text-primary-foreground" aria-label="Close">
					<XIcon className="size-3.5" />
				</DialogPrimitive.Close>
			) : null}
		</DialogPrimitive.Content>
	</DialogPrimitive.Portal>
));
DialogContent.displayName = "DialogContent";

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
	return <div className={cn("flex items-center gap-2 border-b border-border px-3 py-2 font-mono text-[12px] tracking-[0.12em] uppercase", className)} {...props} />;
}

export function DialogBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
	return <div className={cn("min-h-0 flex-1 overflow-y-auto", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
	return <div className={cn("flex items-center justify-end gap-2 border-t border-border px-3 py-2", className)} {...props} />;
}

export const DialogTitle = DialogPrimitive.Title;
