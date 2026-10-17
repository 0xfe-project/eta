import { CheckIcon } from "@phosphor-icons/react/Check";
import { cn } from "@/lib/utils";

/** A dialog's steps atop it, as in connecting GitHub; `complete` ticks all. */
export function Stepper({
  steps,
  step,
  label,
  complete = false,
}: {
  steps: readonly string[];
  step: number;
  label: string;
  complete?: boolean;
}) {
  return (
    <ol
      aria-label={label}
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}
    >
      {steps.map((name, index) => {
        const done = index < step || complete;
        const current = index === step;
        return (
          <li
            key={name}
            aria-current={current ? "step" : undefined}
            className="flex flex-col gap-1.5"
          >
            <span
              aria-hidden="true"
              className={cn(
                "h-0.5 w-full bg-border duration-[60ms] ease-linear",
                (done || current) && "bg-foreground",
              )}
            />
            <span
              className={cn(
                "flex items-center gap-1 text-[11px]",
                current
                  ? "font-medium text-foreground"
                  : done
                    ? "text-foreground/70"
                    : "text-muted-foreground",
              )}
            >
              {done && !current ? (
                <CheckIcon aria-hidden="true" className="size-3 shrink-0" />
              ) : (
                <span aria-hidden="true" className="tabular-nums">
                  {index + 1}
                </span>
              )}
              <span className="truncate">{name}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
