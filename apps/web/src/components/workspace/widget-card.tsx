import type { WidgetDetails } from "@eta/client-contracts/widget";
import type { ReactNode } from "react";
import { widgetCatalog } from "@eta/client-contracts/widget";
import { defineRegistry, JSONUIProvider, Renderer } from "@json-render/react";
import { ArrowDownRightIcon } from "@phosphor-icons/react/ArrowDownRight";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { ArrowUpRightIcon } from "@phosphor-icons/react/ArrowUpRight";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type Spec = WidgetDetails["spec"];

/**
 * Items with keys made of what they say: rows a model wrote have no ids, and the same row can come
 * twice, so a repeat is told apart by how many came before it.
 */
function keyed<T>(items: readonly T[]): { key: string; item: T }[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const text = JSON.stringify(item);
    const count = seen.get(text) ?? 0;
    seen.set(text, count + 1);
    return { key: `${text}#${count}`, item };
  });
}

type Tone = "neutral" | "success" | "warning" | "error" | "info" | null;

const toneText: Record<NonNullable<Tone>, string> = {
  neutral: "text-foreground",
  success: "text-state-success",
  warning: "text-state-warning",
  error: "text-state-error",
  info: "text-state-info",
};

const gaps = { sm: "gap-2", md: "gap-3", lg: "gap-4" };
// Whole class names, so Tailwind sees them; a narrow column stacks.
const columns = [
  "",
  "sm:grid-cols-1",
  "sm:grid-cols-2",
  "sm:grid-cols-3",
  "sm:grid-cols-4",
];

const trends = {
  up: { Icon: ArrowUpRightIcon, className: "text-state-success" },
  down: { Icon: ArrowDownRightIcon, className: "text-state-error" },
  flat: { Icon: ArrowRightIcon, className: "text-muted-foreground" },
};

/** The page's own elements for the catalog's components: the app's type, rules and colours. */
const { registry } = defineRegistry(widgetCatalog, {
  components: {
    Stack: ({ props, children }) => (
      <div
        className={cn(
          "flex min-w-0",
          props.direction === "row" ? "flex-row flex-wrap" : "flex-col",
          gaps[props.gap ?? "md"],
        )}
      >
        {children}
      </div>
    ),
    Grid: ({ props, children }) => (
      <div
        className={cn(
          "grid min-w-0 grid-cols-1 gap-2",
          columns[props.columns ?? 2],
        )}
      >
        {children}
      </div>
    ),
    Card: ({ props, children }) => (
      <section className="min-w-0 space-y-2 border border-border p-3">
        {props.title ? (
          <h4 className="text-sm font-medium">{props.title}</h4>
        ) : null}
        {props.description ? (
          <p className="text-xs text-muted-foreground">{props.description}</p>
        ) : null}
        {children}
      </section>
    ),
    Heading: ({ props }) => (
      <h4 className="text-sm font-semibold">{props.text}</h4>
    ),
    Text: ({ props }) => (
      <p className={cn("text-sm", props.muted && "text-muted-foreground")}>
        {props.text}
      </p>
    ),
    Metric: ({ props }) => {
      const trend = props.trend ? trends[props.trend] : undefined;
      return (
        <div className="min-w-0 border border-border px-3 py-2">
          <div className="truncate text-xs text-muted-foreground">
            {props.label}
          </div>
          <div className="text-lg font-semibold tabular-nums">
            {props.value}
          </div>
          {props.detail || trend ? (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              {trend ? (
                <trend.Icon aria-hidden className={trend.className} />
              ) : null}
              {props.detail}
            </div>
          ) : null}
        </div>
      );
    },
    Badge: ({ props }) => (
      <Badge variant="outline" className={toneText[props.tone ?? "neutral"]}>
        {props.text}
      </Badge>
    ),
    Progress: ({ props }) => {
      const max = props.max ?? 100;
      const share = max > 0 ? Math.min(Math.max(props.value / max, 0), 1) : 0;
      return (
        <div className="space-y-1">
          <div className="flex justify-between gap-2 text-xs">
            <span className="truncate">{props.label}</span>
            <span className="text-muted-foreground tabular-nums">
              {Math.round(share * 100)}%
            </span>
          </div>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={max}
            aria-valuenow={props.value}
            aria-label={props.label ?? undefined}
            className="h-1.5 bg-muted"
          >
            <div
              className="h-full bg-foreground"
              style={{ width: `${share * 100}%` }}
            />
          </div>
        </div>
      );
    },
    BarChart: ({ props }) => {
      const top = Math.max(...props.data.map((row) => row.value), 0);
      return (
        <div className="grid grid-cols-[minmax(0,8rem)_1fr_auto] items-center gap-x-2 gap-y-1 text-xs">
          {keyed(props.data).map(({ key, item: row }) => (
            <div key={key} className="contents">
              <span className="truncate">{row.label}</span>
              <div className="h-3 bg-muted">
                <div
                  className="h-full bg-chart-2"
                  style={{
                    width: `${top > 0 ? (Math.max(row.value, 0) / top) * 100 : 0}%`,
                  }}
                />
              </div>
              <span className="text-right text-muted-foreground tabular-nums">
                {row.value}
                {props.unit}
              </span>
            </div>
          ))}
        </div>
      );
    },
    Table: ({ props }) => (
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              {keyed(props.columns).map(({ key, item: column }) => (
                <th key={key} className="px-2 py-1 font-medium">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {keyed(props.rows).map(({ key, item: row }) => (
              <tr key={key} className="border-b border-border last:border-0">
                {keyed(row).map(({ key: cellKey, item: cell }) => (
                  <td key={cellKey} className="px-2 py-1 tabular-nums">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ),
    List: ({ props }) => {
      const List = props.ordered ? "ol" : "ul";
      return (
        <List
          className={cn(
            "space-y-0.5 pl-5 text-sm",
            props.ordered ? "list-decimal" : "list-disc",
          )}
        >
          {keyed(props.items).map(({ key, item }) => (
            <li key={key}>{item}</li>
          ))}
        </List>
      );
    },
    Callout: ({ props }) => (
      <p
        className={cn(
          "border border-border px-3 py-2 text-sm",
          toneText[props.tone ?? "neutral"],
        )}
      >
        {props.text}
      </p>
    ),
    Divider: () => <Separator />,
  },
});

/**
 * A widget the agent drew, beside its answer. While the call streams it draws what has arrived;
 * an element whose children have not arrived yet draws without them.
 */
export function WidgetCard({
  title,
  spec,
  streaming,
}: {
  title: string;
  spec: Spec;
  streaming: boolean;
}) {
  const drawn: ReactNode =
    spec.root !== undefined && spec.elements?.[spec.root] !== undefined ? (
      <Renderer spec={spec} registry={registry} loading={streaming} />
    ) : (
      <Skeleton className="h-16" />
    );
  return (
    // No frame or caption of its own: the spec draws its sections, and its title is what it shows.
    <figure
      className="min-w-0"
      aria-label={title || undefined}
      aria-busy={streaming}
    >
      <JSONUIProvider registry={registry} initialState={spec.state}>
        {drawn}
      </JSONUIProvider>
    </figure>
  );
}
