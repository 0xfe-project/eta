import type { EmailMetaView } from "@eta/client-contracts";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

function display(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "✓" : "—";
  if (typeof value === "string") return value || "—";
  if (typeof value === "number") return String(value);
  return "";
}

function NestedValue({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item !== "object" || item === null)) {
      return (
        <div className="flex flex-wrap gap-1">
          {value.length === 0 ? (
            <span>—</span>
          ) : (
            value.map((item) => (
              <span
                key={JSON.stringify(item)}
                className="border bg-muted/50 px-1.5 py-0.5 font-mono text-[10px]"
              >
                {display(item)}
              </span>
            ))
          )}
        </div>
      );
    }
    return (
      <ol className="list-decimal space-y-2 pl-5">
        {value.map((item) => (
          <li key={JSON.stringify(item)}>
            <NestedValue value={item} />
          </li>
        ))}
      </ol>
    );
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    if (entries.length === 0) return <span>—</span>;
    return (
      <dl className="space-y-2">
        {entries.map(([key, item]) => (
          <div
            key={key}
            className="grid grid-cols-[minmax(5rem,0.8fr)_minmax(0,1.6fr)] gap-2 sm:grid-cols-[minmax(7rem,0.7fr)_minmax(0,2fr)] sm:gap-3"
          >
            <dt className="break-words font-mono text-[10px] text-muted-foreground">
              {key}
            </dt>
            <dd className="min-w-0 break-words">
              <NestedValue value={item} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return <span className="break-words font-mono">{display(value)}</span>;
}

function contextEntries(value: unknown): [string, unknown][] {
  if (Array.isArray(value)) {
    return value.map((item, index) => [String(index + 1), item]);
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value);
  }
  return value === null || value === undefined ? [] : [["value", value]];
}

function summarize(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "—";
    if (value.every((item) => typeof item !== "object" || item === null)) {
      const visible = value.slice(0, 5).map(display).join(" · ");
      return value.length > 5 ? `${visible} …` : visible;
    }
    return `${value.length} ×`;
  }
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value);
    return keys.length === 0 ? "—" : keys.slice(0, 5).join(" · ");
  }
  const text = display(value).replace(/\s+/g, " ").trim();
  return text.length > 180 ? `${text.slice(0, 177)}…` : text;
}

function MetaStat({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0 border-b border-r px-2.5 py-2 last:border-r-0 sm:border-b-0">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd
        className={cn(
          "mt-0.5 truncate text-xs font-medium",
          mono && "font-mono text-[11px]",
        )}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

function Row({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2 px-3 py-2 text-[11px] leading-5 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`min-w-0 break-words ${mono ? "font-mono" : ""}`}>
        {children}
      </dd>
    </div>
  );
}

export function EmailMetaPanel({ meta }: { meta: EmailMetaView }) {
  const { t } = useTranslation(["email"] as const);
  const [fullContext, setFullContext] = useState(false);
  const entries = contextEntries(meta.payload);
  const routing = [
    [t("thread.metaAgentId"), meta.agentId],
    [t("thread.metaSession"), meta.sessionId],
    [t("thread.metaLogicalSession"), meta.logicalSessionId],
    [t("thread.metaMailThread"), meta.mailThreadId],
    [t("thread.metaTask"), meta.taskId],
    [t("thread.metaCarrier"), meta.carrier],
  ].filter((entry): entry is [string, string] => entry[1] !== null);
  const contextCount = routing.length + entries.length;
  const signature =
    meta.signatureValid === true
      ? t("thread.metaSignatureValid")
      : meta.signatureValid === false
        ? t("thread.metaSignatureInvalid")
        : meta.signaturePresent
          ? t("thread.metaSignatureUnchecked")
          : t("thread.metaUnsigned");
  return (
    <details className="group mt-3 border bg-muted/10">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-3 [&::-webkit-details-marker]:hidden">
        <span className="grid size-8 shrink-0 place-items-center border bg-background font-mono text-[10px] font-semibold tracking-tight">
          ETA
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-xs font-semibold">{t("thread.meta")}</span>
            <span className="border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {meta.packetCount > 0
                ? t("thread.packets", { count: meta.packetCount })
                : t("thread.noPackets")}
            </span>
          </span>
          <span className="mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
            <span className="truncate">{meta.agentName ?? "—"}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono">{meta.protocol ?? "—"}</span>
            <span aria-hidden="true">·</span>
            <span>
              {contextCount > 0
                ? t("thread.metaContextCount", { count: contextCount })
                : t("thread.noExtraContext")}
            </span>
          </span>
        </span>
        <CaretDownIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="border-t px-3 pb-3 pt-3">
        <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
          {t("thread.metaHint")}
        </p>
        <dl className="grid grid-cols-2 border-l border-t sm:grid-cols-4">
          <MetaStat
            label={t("thread.metaAgent")}
            value={meta.agentName ?? "—"}
          />
          <MetaStat
            label={t("thread.metaProtocol")}
            value={meta.protocol ?? "—"}
            mono
          />
          <MetaStat
            label={t("thread.metaPoints")}
            value={t("thread.packets", { count: meta.packetCount })}
          />
          <MetaStat label={t("thread.metaSignature")} value={signature} />
        </dl>
        <section className="mt-3 border bg-background">
          <header className="flex items-center justify-between gap-3 border-b px-3 py-2">
            <h3 className="text-xs font-semibold">{t("thread.metaContext")}</h3>
            <span className="text-[10px] text-muted-foreground">
              {t("thread.metaContextCount", { count: contextCount })}
            </span>
          </header>
          <div>
            <h4 className="border-b bg-muted/20 px-3 py-1.5 text-[10px] font-medium text-muted-foreground">
              {t("thread.metaRouteContext")}
            </h4>
            <dl className="divide-y">
              {routing.map(([label, value]) => (
                <Row key={label} label={label} mono>
                  {value}
                </Row>
              ))}
            </dl>
          </div>
          <div className="border-t">
            <h4 className="flex items-center justify-between gap-3 border-b bg-muted/20 px-3 py-1.5 text-[10px] font-medium text-muted-foreground">
              <span>{t("thread.metaAdditionalContext")}</span>
              <span>
                {t("thread.metaContextCount", { count: entries.length })}
              </span>
            </h4>
            {entries.length > 0 ? (
              <>
                <dl className="divide-y">
                  {(fullContext ? entries : entries.slice(0, 6)).map(
                    ([key, value]) => (
                      <div
                        key={key}
                        className="grid grid-cols-[minmax(5rem,0.7fr)_minmax(0,1.8fr)] gap-3 px-3 py-2"
                      >
                        <dt className="break-words font-mono text-[10px] leading-5 text-muted-foreground">
                          {key}
                        </dt>
                        <dd className="min-w-0 break-words text-[11px] leading-5">
                          {fullContext ? (
                            <NestedValue value={value} />
                          ) : (
                            <span className="font-mono">
                              {summarize(value)}
                            </span>
                          )}
                        </dd>
                      </div>
                    ),
                  )}
                </dl>
                <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
                  {entries.length > 6 && !fullContext ? (
                    <span className="mr-auto text-[10px] text-muted-foreground">
                      {t("thread.metaMoreContext", {
                        count: entries.length - 6,
                      })}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="ml-auto border-b border-foreground/40 text-[11px] font-medium hover:border-foreground"
                    onClick={() => setFullContext((current) => !current)}
                  >
                    {fullContext
                      ? t("thread.metaContextCollapse")
                      : t("thread.metaContextExpand")}
                  </button>
                </div>
              </>
            ) : (
              <div className="px-3 py-2.5">
                <p className="text-[11px] font-medium text-muted-foreground">
                  {t("thread.noExtraContext")}
                </p>
                <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                  {t("thread.noExtraContextHint")}
                </p>
              </div>
            )}
          </div>
        </section>
        <details className="group/technical mt-3 border bg-background">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[11px] font-medium [&::-webkit-details-marker]:hidden">
            <CaretDownIcon
              aria-hidden="true"
              className="size-3.5 text-muted-foreground transition-transform group-open/technical:rotate-180"
            />
            {t("thread.metaTechnicalDetails")}
          </summary>
          <dl className="divide-y border-t">
            <Row label={t("thread.metaProtocol")} mono>
              {meta.protocol ?? "—"}
            </Row>
            <Row label={t("thread.metaPoints")}>
              {t("thread.packets", { count: meta.packetCount })}
            </Row>
            <Row label={t("thread.metaSignature")}>{signature}</Row>
            <Row label={t("thread.metaDecode")}>
              {meta.decodeError ?? t("thread.metaDecodeSuccess")}
            </Row>
          </dl>
        </details>
      </div>
    </details>
  );
}
