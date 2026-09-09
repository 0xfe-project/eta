import * as React from "react";
import { cn } from "../../lib/utils";

export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
	return <span className={cn("inline-block border border-border px-1.5 py-px font-mono text-[9px] tracking-[0.14em] uppercase", className)} {...props} />;
}
