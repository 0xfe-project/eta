import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
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

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
	asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
	({ className, variant, size, asChild = false, ...props }, ref) => {
		const Comp = asChild ? Slot : "button";
		return <Comp ref={ref} data-slot="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />;
	},
);
Button.displayName = "Button";

export { buttonVariants };
