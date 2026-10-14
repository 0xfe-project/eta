import type { Interaction } from "@/queries/chat";
import { BellIcon } from "@phosphor-icons/react/Bell";
import { parseAsStringLiteral, useQueryState } from "nuqs";
import { useTranslation } from "react-i18next";
import { Empty, LoadError, Loading } from "@/components/states";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatLocale, translate } from "@/lib/i18n";
import { useInteractionHistory } from "@/queries/chat";
import { PageHeader } from "./app-shell";
import { Confirmation, PendingList } from "./attention";

// Everything waiting for the user, then (under 全部) the confirmations
// already answered or lapsed, by day.

const filterParser = parseAsStringLiteral(["all", "pending"] as const)
  .withDefault("all")
  .withOptions({ history: "push" });

/** "今天", "昨天", "10月6日". */
function day(iso: string) {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString())
    return translate("common:time.today");
  if (date.toDateString() === yesterday.toDateString())
    return translate("common:time.yesterday");
  return new Intl.DateTimeFormat(formatLocale(), {
    month: "short",
    day: "numeric",
  }).format(date);
}

/** What waits for the user and, under 全部, what was confirmed before. */
export function Notifications() {
  const { t: translateText } = useTranslation([
    "chat",
    "common",
    "navigation",
  ] as const);
  const [filter, setFilter] = useQueryState("filter", filterParser);
  const { interactions, isPending, error, refetch } = useInteractionHistory();
  const days = new Map<string, Interaction[]>();
  for (const interaction of interactions) {
    if (interaction.status === "pending") continue;
    const label = day(interaction.created_at);
    days.set(label, [...(days.get(label) ?? []), interaction]);
  }
  return (
    <>
      <PageHeader title={translateText("navigation:sections.pending")}>
        <Tabs
          value={filter}
          onValueChange={(value) => void setFilter(value as typeof filter)}
        >
          <TabsList
            aria-label={translateText("common:labels.filter")}
            className="gap-1"
          >
            <TabsTrigger value="all" className="px-2 text-xs">
              {translateText("common:labels.all")}
            </TabsTrigger>
            <TabsTrigger value="pending" className="px-2 text-xs">
              {translateText("navigation:sections.pending")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </PageHeader>
      <main id="main" className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-1 pb-8 sm:px-3">
          <PendingList />
          {filter === "all" ? (
            <section aria-labelledby="history" className="pt-6">
              <h2
                id="history"
                className="px-3 text-sm font-medium text-muted-foreground"
              >
                {translateText("confirmations.historyTitle")}
              </h2>
              {error ? (
                <LoadError
                  what={translateText("confirmations.historyLabel")}
                  error={error}
                  onRetry={() => void refetch()}
                />
              ) : isPending ? (
                <Loading rows={3} />
              ) : days.size === 0 ? (
                <Empty
                  icon={BellIcon}
                  title={translateText("confirmations.emptyHistory")}
                />
              ) : (
                [...days].map(([label, items]) => (
                  <section key={label} aria-label={label}>
                    <h3 className="sticky top-0 z-10 bg-background px-3 pt-3 pb-1 text-xs font-medium text-muted-foreground">
                      {label}
                    </h3>
                    <ul className="divide-y">
                      {items.map((interaction) => (
                        <Confirmation
                          key={interaction.id}
                          interaction={interaction}
                        />
                      ))}
                    </ul>
                  </section>
                ))
              )}
            </section>
          ) : null}
        </div>
      </main>
    </>
  );
}
