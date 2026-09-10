import { splitProps, type JSX } from "solid-js";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
	"inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 border text-[12px] whitespace-nowrap transition-all-[120ms] active:translate-y-[1px] disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0",
	{
		variants: {
			variant: {
				default: "border-transparent bg-primary px-2.5 py-1 font-medium text-primary-foreground hover:bg-primary/85",
				invert: "border-primary bg-primary px-2 py-0.5 font-bold tracking-[0.12em] text-primary-foreground uppercase hover:bg-transparent hover:text-primary",
				outline: "border-border bg-transparent text-foreground hover:border-border-strong hover:bg-overlay",
				ghost: "border-transparent text-muted hover:bg-overlay hover:text-foreground",
				destructive: "border-destructive bg-transparent text-destructive hover:bg-destructive hover:text-white",
			},
			size: {
				sm: "px-2 py-0.5 text-[11px]",
				icon: "size-6 p-0",
			},
		},
		defaultVariants: { variant: "outline" },
	},
);

export interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
	className?: string;
}

export function Button(props: ButtonProps) {
	const [local, rest] = splitProps(props, ["class", "className", "variant", "size"]);
	return (
		<button
			data-slot="button"
			class={cn(buttonVariants({ variant: local.variant, size: local.size }), local.class, local.className)}
			{...rest}
		/>
	);
}

export { buttonVariants };
