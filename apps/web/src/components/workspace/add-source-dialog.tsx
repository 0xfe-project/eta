import type {
  EtaModelConfig,
  LlmConnector,
  ProviderDiscoverResult,
  ProviderKind,
  UnsupportedModel,
} from "@eta/client-contracts";
import type { ReactNode } from "react";
import {
  BUILTIN_PROVIDER_PRESETS,
  ETA_TOKEN_PLAN_KEYS_URL,
} from "@eta/client-contracts";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { translate } from "@/lib/i18n";
import { useLlm } from "@/queries/llm";
import { logoKey, useSourceLogos } from "@/queries/logos";
import {
  discoverProviderModels,
  discoveryErrorMessage,
  providerErrorMessage,
  useCheckProviders,
  useProviders,
  useSaveProvider,
} from "@/queries/providers";
import { DeviceLogin, GatewayKeyForm } from "./account-login";
import { Select, SelectOption } from "./select-field";
import { AccountModels } from "./source-models";
import { SourceLogo, Tag } from "./source-parts";
import { abilityTags, formatContext, protocolName } from "./source-text";
import { Stepper } from "./stepper";

// Adding a model source in three steps: pick where the models come from, connect to it (a key, a
// sign-in, an address), pick the models. Connecting lists the models once — getting the list is
// what says the connection works — and the list arrives with models.dev's facts already in it.

/** One card of the first step: a gateway connector, or a kind the config holds. */
type SourcePreset =
  | { id: string; group: "subscription" | "key"; connector: string }
  | {
      id: string;
      group: "recommended" | "key" | "custom";
      kind: ProviderKind;
      baseUrl: string;
      /** The address and protocol are the person's: the custom endpoint and the local server. */
      custom?: "endpoint" | "local";
    };

const LOCAL_URL = "http://127.0.0.1:11434/v1";

const keyPreset = (kind: keyof typeof BUILTIN_PROVIDER_PRESETS) => ({
  id: kind,
  group: "key" as const,
  kind,
  baseUrl: BUILTIN_PROVIDER_PRESETS[kind].baseUrl,
});

/** Eta's own gateway: one key, on top of every group. */
const ETA_PRESET: SourcePreset = {
  id: "eta",
  group: "recommended",
  kind: "eta",
  baseUrl: BUILTIN_PROVIDER_PRESETS.eta.baseUrl,
};

const SOURCE_PRESETS: readonly SourcePreset[] = [
  ETA_PRESET,
  { id: "codex", group: "subscription", connector: "codex" },
  { id: "xai", group: "subscription", connector: "xai" },
  keyPreset("deepseek"),
  keyPreset("kimi-coding"),
  keyPreset("zai-coding-cn"),
  keyPreset("zai"),
  { id: "gemini", group: "key", connector: "gemini" },
  keyPreset("opencode"),
  keyPreset("opencode-go"),
  {
    id: "custom",
    group: "custom",
    kind: "openai-compatible",
    baseUrl: "",
    custom: "endpoint",
  },
  {
    id: "local",
    group: "custom",
    kind: "openai-compatible",
    baseUrl: LOCAL_URL,
    custom: "local",
  },
];

const GROUPS = ["subscription", "key", "custom"] as const;

const presetLogo = (
  preset: SourcePreset,
  logos: Readonly<Record<string, string>>,
) =>
  "connector" in preset
    ? logos[logoKey.connector(preset.connector)]
    : preset.custom === undefined
      ? logos[logoKey.kind(preset.kind)]
      : undefined;

function presetName(
  preset: SourcePreset,
  connectors: readonly LlmConnector[],
): string {
  if ("connector" in preset)
    return (
      connectors.find((connector) => connector.id === preset.connector)?.name ??
      preset.connector
    );
  if (preset.custom === "endpoint")
    return translate("providers:add.presets.custom");
  if (preset.custom === "local")
    return translate("providers:add.presets.local");
  return BUILTIN_PROVIDER_PRESETS[
    preset.kind as keyof typeof BUILTIN_PROVIDER_PRESETS
  ].name;
}

/** A name as an id: the provider's address in the config, and the front of its model ids. */
function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function uniqueId(name: string, taken: readonly string[]): string {
  const base = slug(name) || "provider";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

/** What a custom endpoint is called before anyone names it: the server it is, or its host. */
function endpointName(baseUrl: string, local: boolean): string {
  try {
    const url = new URL(baseUrl);
    if (local)
      return url.port === "11434"
        ? "Ollama"
        : url.port === "1234"
          ? "LM Studio"
          : translate("providers:add.presets.local");
    return url.host.replace(/^api\./, "");
  } catch {
    return translate("providers:add.presets.custom");
  }
}

/**
 * The models ticked when the list arrives. A preset's list is curated by its provider, so all of
 * it that is current; a custom endpoint may list hundreds (OpenRouter), so only a short list is.
 */
function recommended(
  models: readonly EtaModelConfig[],
  custom: boolean,
): string[] {
  const current = models.filter((model) => model.deprecated !== true);
  if (custom && current.length > 12) return [];
  return current.map((model) => model.id);
}

/** What a protocol package is called where a person reads it. */
const PROTOCOL_NAMES: Record<string, string> = {
  "@ai-sdk/anthropic": "Anthropic",
  "@ai-sdk/google": "Google",
  "@ai-sdk/google-vertex": "Google",
  "@ai-sdk/mistral": "Mistral",
};

function unsupportedReason(model: UnsupportedModel): string {
  if (model.reason === "protocol")
    return translate("providers:add.unsupported", {
      protocol: PROTOCOL_NAMES[model.protocol] ?? model.protocol,
    });
  return translate(
    model.reason === "endpoint"
      ? "providers:add.otherEndpoint"
      : "providers:add.incomplete",
  );
}

function PresetGrid({ onPick }: { onPick: (preset: SourcePreset) => void }) {
  const { t: translateText } = useTranslation(["providers"] as const);
  const llm = useLlm();
  const logos = useSourceLogos();
  const offered = SOURCE_PRESETS.filter(
    (preset) =>
      !("connector" in preset) ||
      llm.connectors.some((connector) => connector.id === preset.connector),
  );
  const recommended = offered.filter(
    (preset) => preset.group === "recommended",
  );
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      {recommended.map((preset) => {
        const name = presetName(preset, llm.connectors);
        return (
          <button
            key={preset.id}
            type="button"
            className="flex min-w-0 items-center gap-2.5 border p-2.5 text-left text-xs duration-[60ms] ease-linear hover:bg-overlay-hover focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => onPick(preset)}
          >
            <SourceLogo name={name} svg={presetLogo(preset, logos)} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{name}</span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {translateText("add.presets.etaHint")}
              </span>
            </span>
            <Tag>{translateText("add.recommended")}</Tag>
          </button>
        );
      })}
      {GROUPS.map((group) => {
        const presets = offered.filter((preset) => preset.group === group);
        if (presets.length === 0) return null;
        const headingId = `add-source-${group}`;
        return (
          <section key={group} aria-labelledby={headingId}>
            <h3
              id={headingId}
              className="mb-1.5 font-mono text-[10.5px] tracking-widest text-faint uppercase"
            >
              {translateText(`add.groups.${group}`)}
            </h3>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-1.5">
              {presets.map((preset) => {
                const name = presetName(preset, llm.connectors);
                return (
                  <button
                    key={preset.id}
                    type="button"
                    className="flex min-w-0 items-center gap-2 border p-2 text-left text-xs duration-[60ms] ease-linear hover:bg-overlay-hover focus-visible:outline-2 focus-visible:outline-ring"
                    onClick={() => onPick(preset)}
                  >
                    <SourceLogo name={name} svg={presetLogo(preset, logos)} />
                    <span className="min-w-0">
                      <span className="block truncate">{name}</span>
                      {"custom" in preset && preset.custom === "local" ? (
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {translateText("add.presets.localHint")}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

interface Listing extends ProviderDiscoverResult {
  /** The connection the list was fetched with: what the saved provider is. */
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
}

function ModelPicker({
  listing,
  selected,
  onToggle,
}: {
  listing: Listing;
  selected: ReadonlySet<string>;
  onToggle: (id: string, on: boolean) => void;
}) {
  const { t: translateText } = useTranslation(["providers"] as const);
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const matches = (model: { id: string; name?: string | undefined }) =>
    `${model.id} ${model.name ?? ""}`.toLowerCase().includes(query);
  const models = listing.models.filter(matches);
  const unsupported = (listing.unsupported ?? []).filter(matches);
  if (listing.models.length === 0 && !listing.unsupported?.length)
    return (
      <p className="text-xs text-muted-foreground">
        {translateText("add.noModels")}
      </p>
    );
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
      <div className="flex items-center gap-2">
        <Input
          aria-label={translateText("models.search")}
          placeholder={translateText("models.search")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="h-7 max-w-64 text-xs"
        />
        <span role="status" className="ml-auto text-xs text-muted-foreground">
          {translateText("add.selected", { count: selected.size })}
        </span>
      </div>
      <ul
        aria-label={translateText("add.steps.models")}
        className="max-h-72 divide-y overflow-y-auto border"
      >
        {models.map((model) => {
          const label = model.name ?? model.id;
          return (
            <li key={model.id}>
              <label className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-xs hover:bg-overlay-hover">
                <Checkbox
                  checked={selected.has(model.id)}
                  onCheckedChange={(checked) =>
                    onToggle(model.id, checked === true)
                  }
                />
                <span className="min-w-0 flex-1 truncate">
                  {label}
                  {label !== model.id ? (
                    <span className="ml-1.5 font-mono text-[11px] text-faint">
                      {model.id}
                    </span>
                  ) : null}
                </span>
                {model.deprecated ? (
                  <Tag>{translateText("models.deprecated")}</Tag>
                ) : null}
                {abilityTags(model).map((tag) => (
                  <Tag key={tag}>{tag}</Tag>
                ))}
                <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">
                  {formatContext(model.contextWindow)}
                </span>
              </label>
            </li>
          );
        })}
        {unsupported.map((model) => (
          <li
            key={model.id}
            className="flex items-center gap-2 px-2 py-1.5 text-xs text-faint"
          >
            <Checkbox
              checked={false}
              disabled
              aria-label={model.name ?? model.id}
            />
            <span className="min-w-0 flex-1 truncate">
              {model.name ?? model.id}
            </span>
            <span className="shrink-0">{unsupportedReason(model)}</span>
          </li>
        ))}
        {models.length === 0 && unsupported.length === 0 ? (
          <li className="px-2 py-1.5 text-xs text-muted-foreground">
            {translateText("models.noMatches")}
          </li>
        ) : null}
      </ul>
    </div>
  );
}

/** The models a gateway account brings: nothing to choose, they come with the sign-in. */
function AccountReady({ connector }: { connector: LlmConnector }) {
  const { t: translateText } = useTranslation(["providers"] as const);
  const { models } = useLlm();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
      <p role="status" className="text-xs">
        {translateText("add.accountReady", {
          name: connector.name,
          count: models.filter((model) => model.connector === connector.id)
            .length,
        })}
      </p>
      <AccountModels connector={connector} />
    </div>
  );
}

export function AddSourceDialog({
  open,
  onOpenChange,
  initialPreset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens on this preset's connect step (the empty list's way to Eta Token Plan). */
  initialPreset?: string;
}) {
  const { t: translateText } = useTranslation(["providers", "common"] as const);
  const formId = useId();
  const { data: config } = useProviders();
  const llm = useLlm();
  const save = useSaveProvider();
  const check = useCheckProviders();
  const found = SOURCE_PRESETS.find((entry) => entry.id === initialPreset);
  const initial =
    found === undefined || "connector" in found ? undefined : found;
  const [step, setStep] = useState(initial === undefined ? 0 : 1);
  const [preset, setPreset] = useState<SourcePreset | undefined>(initial);
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [kind, setKind] = useState<ProviderKind>(
    initial?.kind ?? "openai-compatible",
  );
  const [apiKey, setApiKey] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string>();
  const [listing, setListing] = useState<Listing>();
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [signedIn, setSignedIn] = useState(false);

  const connector =
    preset !== undefined && "connector" in preset
      ? llm.connectors.find((candidate) => candidate.id === preset.connector)
      : undefined;
  const custom =
    preset !== undefined && "custom" in preset ? preset.custom : undefined;
  const name =
    preset === undefined
      ? ""
      : custom === undefined
        ? presetName(preset, llm.connectors)
        : endpointName(listing?.baseUrl ?? baseUrl, custom === "local");

  const close = () => onOpenChange(false);
  const pick = (next: SourcePreset) => {
    setPreset(next);
    setBaseUrl("connector" in next ? "" : next.baseUrl);
    setKind("connector" in next ? "openai-compatible" : next.kind);
    setApiKey("");
    setError(undefined);
    setListing(undefined);
    setSignedIn(false);
    setStep(1);
  };

  const connect = async () => {
    if (preset === undefined || "connector" in preset || connecting) return;
    setConnecting(true);
    setError(undefined);
    const key = apiKey.trim();
    const url = baseUrl.trim();
    try {
      const result = await discoverProviderModels({
        kind,
        baseUrl: url,
        ...(key.length > 0 ? { apiKey: key } : {}),
      });
      setListing({ ...result, kind, baseUrl: url, apiKey: key });
      setSelected(new Set(recommended(result.models, custom !== undefined)));
      setStep(2);
    } catch (cause) {
      setError(discoveryErrorMessage(cause));
    } finally {
      setConnecting(false);
    }
  };

  const finish = () => {
    if (listing === undefined || config === undefined) {
      close();
      return;
    }
    const id = uniqueId(
      name,
      config.providers.map((provider) => provider.id),
    );
    save.mutate(
      {
        provider: {
          id,
          name,
          kind: listing.kind,
          baseUrl: listing.baseUrl,
          ...(listing.apiKey.length > 0 ? { apiKey: listing.apiKey } : {}),
          models: listing.models.filter((model) => selected.has(model.id)),
        },
      },
      {
        onSuccess: () => {
          toast.success(translateText("add.added", { name }));
          // The list was the check; recording it is one more look with the saved key.
          check.mutate({ id });
          close();
        },
        onError: (cause) => toast.error(providerErrorMessage(cause)),
      },
    );
  };

  const steps = [
    translateText("add.steps.source"),
    translateText("add.steps.connect"),
    translateText("add.steps.models"),
  ];
  const keyRequired =
    preset !== undefined && !("connector" in preset) && custom === undefined;

  let body: ReactNode;
  let primary: ReactNode = null;
  if (step === 0 || preset === undefined) {
    body = <PresetGrid onPick={pick} />;
  } else if (step === 1 && connector !== undefined) {
    if (connector.flow === "api_key") {
      body = (
        <GatewayKeyForm
          connector={connector}
          formId={formId}
          onPendingChange={setConnecting}
          onDone={() => {
            setSignedIn(true);
            setStep(2);
          }}
        />
      );
      primary = (
        <Button type="submit" form={formId} disabled={connecting}>
          {connecting
            ? translateText("add.connecting")
            : translateText("add.connect")}
        </Button>
      );
    } else {
      body = (
        <DeviceLogin
          connector={connector}
          onDone={() => {
            setSignedIn(true);
            setStep(2);
          }}
        />
      );
    }
  } else if (step === 1) {
    body = (
      <form
        id={formId}
        className="grid grid-cols-[minmax(0,1fr)] gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void connect();
        }}
      >
        {custom !== undefined ? (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
            <label
              htmlFor={`${formId}-url`}
              className="text-xs text-muted-foreground"
            >
              {translateText("add.baseUrl")}
            </label>
            <Input
              id={`${formId}-url`}
              className="font-mono"
              value={baseUrl}
              required
              spellCheck={false}
              placeholder="https://…/v1"
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </div>
        ) : null}
        {custom === "endpoint" ? (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
            <label
              id={`${formId}-protocol`}
              className="text-xs text-muted-foreground"
            >
              {translateText("add.protocol")}
            </label>
            <Select
              aria-labelledby={`${formId}-protocol`}
              value={kind}
              onValueChange={(value) => setKind(value as ProviderKind)}
              className="w-56"
            >
              {(["openai-compatible", "openai-responses"] as const).map(
                (choice) => (
                  <SelectOption key={choice} value={choice}>
                    {protocolName(choice)}
                  </SelectOption>
                ),
              )}
            </Select>
          </div>
        ) : null}
        <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
          <label
            htmlFor={`${formId}-key`}
            className="text-xs text-muted-foreground"
          >
            {custom === undefined
              ? translateText("add.keyLabel", { name })
              : translateText("add.keyOptional")}
          </label>
          <Input
            id={`${formId}-key`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            required={keyRequired}
            value={apiKey}
            aria-invalid={error === undefined ? undefined : true}
            onChange={(event) => {
              setApiKey(event.target.value);
              setError(undefined);
            }}
          />
          {kind === "eta" ? (
            <a
              href={ETA_TOKEN_PLAN_KEYS_URL}
              target="_blank"
              rel="noreferrer"
              className="justify-self-start text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              {translateText("add.getEtaKey")}
            </a>
          ) : null}
        </div>
        {error === undefined ? null : (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </form>
    );
    primary = (
      <Button
        type="submit"
        form={formId}
        disabled={
          connecting ||
          (keyRequired && apiKey.trim().length === 0) ||
          baseUrl.trim().length === 0
        }
      >
        {connecting
          ? translateText("add.connecting")
          : translateText("add.connect")}
      </Button>
    );
  } else if (connector !== undefined) {
    body = signedIn ? <AccountReady connector={connector} /> : null;
    primary = <Button onClick={close}>{translateText("add.finish")}</Button>;
  } else if (listing !== undefined) {
    body = (
      <ModelPicker
        listing={listing}
        selected={selected}
        onToggle={(id, on) =>
          setSelected((current) => {
            const next = new Set(current);
            if (on) next.add(id);
            else next.delete(id);
            return next;
          })
        }
      />
    );
    primary = (
      <Button onClick={finish} disabled={save.isPending || selected.size === 0}>
        {translateText("add.finish")}
      </Button>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100svh-2rem)] max-w-[calc(100%-2rem)] flex-col gap-0 p-0 sm:max-w-xl">
        <DialogHeader className="gap-2 border-b px-4 py-3">
          <DialogTitle className="text-sm">
            {preset === undefined || step === 0
              ? translateText("add.title")
              : name}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {translateText("add.title")}
          </DialogDescription>
          <Stepper
            steps={steps}
            step={step}
            label={translateText("add.title")}
          />
        </DialogHeader>
        <div className="min-h-80 overflow-y-auto px-4 py-3.5">{body}</div>
        <DialogFooter className="flex-row justify-between border-t px-3 py-2.5 sm:justify-between">
          <Button variant="ghost" onClick={close}>
            {translateText("common:actions.cancel")}
          </Button>
          <div className="flex gap-2">
            {step > 0 && !(step === 2 && connector !== undefined) ? (
              <Button
                variant="outline"
                onClick={() => {
                  setError(undefined);
                  setStep(step - 1);
                }}
              >
                {translateText("add.back")}
              </Button>
            ) : null}
            {primary}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
