import type {
  EtaModelConfig,
  ModelCapabilities,
  ProviderInput,
  ProviderKind,
  ProviderSummary,
} from "@eta/client-contracts";
/**
 * Editing one provider, in place: the settings column turns into this form and Back brings the list
 * back. It is not a dialog — a form one level deep inside another one asks the person to keep track
 * of two ways out, and the thing being edited is one row of the list behind it.
 *
 * The form is written against what the host can actually do: a change is written to `config.json`,
 * which the host reads per turn, so it takes effect on the next request. Nothing is restarted.
 *
 * The key field starts empty and says whether a key is configured: an editor can replace one
 * without ever being shown it.
 *
 * A save carries the revision of the config this form was read from. If the config changed since
 * (another tab, an editor on the file), the host refuses, the page re-reads it, and the person is
 * told to look again before saving once more.
 */
import { BUILTIN_PROVIDER_PRESETS } from "@eta/client-contracts";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { listSeparator } from "@/lib/i18n";
import { THINKING_LEVELS } from "@/lib/thinking";
import {
  currentRevision,
  discoverProviderModels,
  discoveryErrorMessage,
  fetchModelMetadata,
  isConfigChanged,
  providerErrorMessage,
  providerLabel,
  useDeleteProvider,
  useProviders,
  useSaveProvider,
} from "@/queries/providers";
import { wireErrorMessage } from "@/queries/wire";
import { Select, SelectOption } from "./select-field";
import { useAgents } from "./use-agents";

const PRESETS = Object.entries(BUILTIN_PROVIDER_PRESETS).filter(
  ([kind]) => kind !== "openai-codex",
);

/** Kinds you point at an endpoint of your own: their models are yours to spell out. */
const CUSTOM_KINDS: readonly ProviderKind[] = [
  "openai-compatible",
  "openai-responses",
];
const isCustomKind = (kind: ProviderKind) => CUSTOM_KINDS.includes(kind);

/** One model in the form: what can be edited, and the config entry it came from. */
interface ModelRow {
  id: string;
  name: string;
  contextWindow: string;
  vision: boolean;
  reasoning: boolean;
  defaultThinking: EtaModelConfig["defaultThinking"];
  source?: EtaModelConfig;
  edited?: (keyof ModelCapabilities)[];
}

function rowOf(model: EtaModelConfig): ModelRow {
  return {
    id: model.id,
    name: model.name ?? "",
    contextWindow:
      model.contextWindow === undefined ? "" : String(model.contextWindow),
    vision: model.input?.includes("image") ?? false,
    reasoning: model.reasoning === true,
    defaultThinking: model.defaultThinking,
    source: model,
  };
}

/**
 * The entry a row saves as. Everything the form does not show (token limits, thinking modes,
 * efforts) stays as it was, and what the person changed goes in `overrides`, which discovery keeps.
 */
function modelOf(row: ModelRow): EtaModelConfig | undefined {
  const id = row.id.trim();
  if (id.length === 0) return undefined;
  const was = row.source;
  const changes: ModelCapabilities = {};
  const name = row.name.trim();
  if (name.length > 0 && name !== was?.name) changes.name = name;
  const contextWindow = Number(row.contextWindow);
  if (
    row.contextWindow.trim().length > 0 &&
    Number.isInteger(contextWindow) &&
    contextWindow > 0 &&
    contextWindow !== was?.contextWindow
  )
    changes.contextWindow = contextWindow;
  if (
    row.vision !== (was?.input?.includes("image") ?? false) ||
    (row.edited?.includes("input") && was?.input === undefined)
  )
    changes.input = row.vision ? ["text", "image"] : ["text"];
  const overrides = { ...was?.overrides, ...changes };
  const base: EtaModelConfig = { ...(was ?? { id }) };
  if (row.defaultThinking === undefined) delete base.defaultThinking;
  else base.defaultThinking = row.defaultThinking;
  return {
    ...base,
    id,
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
  };
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
  const base = slug(name);
  if (base.length === 0) return "";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

function inputOf(form: {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  key: string;
  clearKey: boolean;
  headers: { name: string; value: string }[];
  models: ModelRow[];
}): ProviderInput {
  const name = form.name.trim();
  const input: ProviderInput = {
    id: form.id,
    ...(name.length > 0 ? { name } : {}),
    kind: form.kind,
    baseUrl: form.baseUrl.trim(),
    headers: Object.fromEntries(
      form.headers
        .map((row) => [row.name.trim(), row.value.trim()] as const)
        .filter(([header]) => header.length > 0)
        .map(([header, value]) => [header, value.length === 0 ? null : value]),
    ),
    models: form.models.flatMap((row) => modelOf(row) ?? []),
  };
  // Absent means "leave it alone"; null means "take it away". An untouched field must not erase
  // the key just because the form had nothing to put in it.
  if (form.clearKey) input.apiKey = null;
  else if (form.key.trim().length > 0) input.apiKey = form.key.trim();
  return input;
}

/** One model as a card: what it is, what it can do, and the fields behind a disclosure. */
function ModelCard({
  row,
  index,
  onUpdate,
  onRemove,
}: {
  row: ModelRow;
  index: number;
  onUpdate: (patch: Partial<ModelRow>) => void;
  onRemove: () => void;
}) {
  const { t: translateText } = useTranslation(["providers"] as const);
  const id = row.id.trim();
  const name = row.name.trim();
  const title =
    name.length > 0
      ? name
      : id.length > 0
        ? id
        : translateText("editor.newModel");
  return (
    <div className="settings-model">
      <div className="settings-model-title">
        <strong className="font-mono">{title}</strong>
        <button
          type="button"
          className="settings-text-button"
          aria-label={translateText("editor.removeModel", { name: title })}
          onClick={onRemove}
        >
          ✕
        </button>
      </div>
      {name.length > 0 && name !== id ? (
        <p className="settings-hint font-mono">{id}</p>
      ) : null}
      <div className="settings-model-meta">
        <span>
          {row.contextWindow.trim().length > 0
            ? `${Number(row.contextWindow).toLocaleString()} tokens`
            : translateText("editor.contextUnknown")}
        </span>
        {row.vision ? <span>{translateText("editor.vision")}</span> : null}
        {row.reasoning ? (
          <span>{translateText("editor.reasoning")}</span>
        ) : null}
      </div>
      <div className="settings-row">
        <div className="settings-row-label">
          <label htmlFor={`model-thinking-${index}`}>
            {translateText("editor.defaultThinking")}
          </label>
        </div>
        <div className="settings-control">
          <Select
            id={`model-thinking-${index}`}
            aria-label={`${translateText("editor.defaultThinking")} ${title}`}
            value={row.defaultThinking ?? ""}
            onValueChange={(value) =>
              onUpdate({
                defaultThinking:
                  value === ""
                    ? undefined
                    : (value as ModelRow["defaultThinking"]),
              })
            }
          >
            <SelectOption value="">
              {translateText("editor.followProvider")}
            </SelectOption>
            {THINKING_LEVELS.map((level) => (
              <SelectOption key={level} value={level}>
                {level}
              </SelectOption>
            ))}
          </Select>
        </div>
      </div>
      <details>
        <summary>{translateText("editor.modelSettings")}</summary>
        <div className="settings-model-fields">
          <div className="settings-field">
            <Label htmlFor={`model-id-${index}`}>
              {translateText("editor.modelId")}
            </Label>
            <Input
              id={`model-id-${index}`}
              className="font-mono"
              value={row.id}
              placeholder="model-id"
              onChange={(event) => onUpdate({ id: event.target.value })}
            />
          </div>
          <div className="settings-field">
            <Label htmlFor={`model-name-${index}`}>
              {translateText("editor.modelName")}
            </Label>
            <Input
              id={`model-name-${index}`}
              value={row.name}
              onChange={(event) => onUpdate({ name: event.target.value })}
            />
          </div>
          <div className="settings-field">
            <Label htmlFor={`model-window-${index}`}>
              {translateText("editor.contextWindow")}
            </Label>
            <Input
              id={`model-window-${index}`}
              aria-label={translateText("editor.contextWindow")}
              className="font-mono"
              inputMode="numeric"
              value={row.contextWindow}
              onChange={(event) =>
                onUpdate({ contextWindow: event.target.value })
              }
            />
          </div>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={row.vision}
              onChange={(event) => onUpdate({ vision: event.target.checked })}
            />
            {translateText("editor.vision")}
          </label>
        </div>
      </details>
    </div>
  );
}

/** What a form is worth comparing by: every field a person can change, as one string. */
function fingerprint(form: {
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  headers: Record<string, string | null>;
  models: ModelRow[];
  key: string;
  clearKey: boolean;
}): string {
  return JSON.stringify([
    form.name,
    form.kind,
    form.baseUrl,
    form.key,
    form.clearKey,
    Object.entries(form.headers).filter(([name]) => name.length > 0),
    form.models.map((row) => [
      row.id,
      row.name,
      row.contextWindow,
      row.vision,
      row.defaultThinking ?? "",
      row.source,
      row.edited,
    ]),
  ]);
}

interface ModelPreview {
  connection: string;
  status: "loading" | "ready" | "failed" | "stale";
  models: EtaModelConfig[];
  selected: ModelRow[];
  error?: string;
}

export function ProviderEditor({
  provider,
  onClose,
}: {
  provider: ProviderSummary | undefined;
  onClose: () => void;
}) {
  const { t: translateText } = useTranslation(["providers", "common"] as const);
  const { data: config } = useProviders();
  const { agents } = useAgents();
  const remove = useDeleteProvider();
  const [removing, setRemoving] = useState(false);
  const [name, setName] = useState(provider?.name ?? "");
  const [kind, setKind] = useState<ProviderKind>(
    provider?.kind ?? "openai-compatible",
  );
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [headers, setHeaders] = useState(
    Object.entries(provider?.headers ?? {}).map(([headerName, value]) => ({
      name: headerName,
      value: value ?? "",
    })),
  );
  const [models, setModels] = useState<ModelRow[]>(
    (provider?.models ?? []).map(rowOf),
  );
  const [saved, setSaved] = useState(false);
  const [savedId, setSavedId] = useState(provider?.id);
  const [changedElsewhere, setChangedElsewhere] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  // The config this form was read from: what a save has to be made against.
  const [revision, setRevision] = useState(config?.revision);

  // A dirty form is one the person would lose by leaving it, so Back asks first — the rule the whole
  // settings dialog follows, applied to the one form here that can hold an unsubmitted key. The
  // form is compared against what was last read or written, not against the row behind it: after a
  // save the row follows, and a form that flickered back to "unsaved" while it did would be wrong.
  const [baseline, setBaseline] = useState(() =>
    fingerprint({
      name: provider?.name ?? "",
      kind: provider?.kind ?? "openai-compatible",
      baseUrl: provider?.baseUrl ?? "",
      headers: provider?.headers ?? {},
      models: (provider?.models ?? []).map(rowOf),
      key: "",
      clearKey: false,
    }),
  );
  const current = fingerprint({
    name,
    kind,
    baseUrl,
    headers: Object.fromEntries(headers.map((row) => [row.name, row.value])),
    models,
    key,
    clearKey,
  });
  const [preview, setPreview] = useState<ModelPreview>();
  const [search, setSearch] = useState("");
  const requestRef = useRef(0);
  const pendingRef = useRef(false);
  const connection = JSON.stringify([
    kind,
    baseUrl,
    key,
    clearKey,
    headers,
    revision,
    savedId,
  ]);
  useEffect(() => {
    // A connection change invalidates even an in-flight request (including change then undo).
    requestRef.current += 1;
    pendingRef.current = false;
    setPreview((previous) =>
      previous === undefined
        ? undefined
        : {
            connection,
            status: "stale",
            models: [],
            selected: [],
          },
    );
    return () => {
      requestRef.current += 1;
    };
  }, [connection]);
  const fresh =
    preview?.connection === connection && preview.status === "ready";
  const selected =
    preview?.connection === connection && preview.status !== "stale"
      ? preview.selected.filter(
          (row) => !models.some((existing) => existing.id.trim() === row.id),
        )
      : [];
  const allModels = [...models, ...selected];
  const [metadata, setMetadata] = useState<{
    status: "loading" | "ready" | "failed";
    form: string;
    count?: number;
    error?: string;
  }>();
  const metadataRequestRef = useRef(0);
  const metadataPendingRef = useRef(false);
  const metadataForm = JSON.stringify([connection, allModels]);
  useEffect(() => {
    metadataRequestRef.current += 1;
    metadataPendingRef.current = false;
    return () => {
      metadataRequestRef.current += 1;
    };
  }, [metadataForm]);
  const supplementMetadata = async () => {
    if (metadataPendingRef.current) return;
    metadataPendingRef.current = true;
    const attempt = ++metadataRequestRef.current;
    setMetadata({ status: "loading", form: metadataForm });
    try {
      const result = await fetchModelMetadata({
        kind,
        baseUrl,
        modelIds: allModels.map((row) => row.id.trim()).filter(Boolean),
      });
      if (attempt !== metadataRequestRef.current) return;
      const supplement = (row: ModelRow): ModelRow => {
        const known = result.models.find((model) => model.id === row.id.trim());
        if (!known) return row;
        const source = { ...row.source, id: row.id.trim() };
        const updated = { ...row, source };
        if (
          !row.edited?.includes("name") &&
          !row.name &&
          source.name === undefined &&
          known.name !== undefined
        )
          updated.name = source.name = known.name;
        if (
          !row.edited?.includes("contextWindow") &&
          !row.contextWindow &&
          source.contextWindow === undefined &&
          known.contextWindow !== undefined
        )
          updated.contextWindow = String(
            (source.contextWindow = known.contextWindow),
          );
        if (
          !row.edited?.includes("input") &&
          source.input === undefined &&
          known.input !== undefined
        ) {
          source.input = known.input;
          updated.vision = known.input.includes("image");
        }
        return updated;
      };
      setModels((rows) => rows.map(supplement));
      setPreview((current) =>
        current === undefined
          ? current
          : { ...current, selected: current.selected.map(supplement) },
      );
      setMetadata({
        status: "ready",
        form: JSON.stringify([connection, allModels.map(supplement)]),
        count: result.models.length,
      });
    } catch (error) {
      if (attempt === metadataRequestRef.current)
        setMetadata({
          status: "failed",
          form: metadataForm,
          error: wireErrorMessage(error),
        });
    } finally {
      if (attempt === metadataRequestRef.current)
        metadataPendingRef.current = false;
    }
  };
  const currentMetadata =
    metadata?.form === metadataForm ? metadata : undefined;
  const dirty = current !== baseline || selected.length > 0;
  const fetching =
    preview?.connection === connection && preview.status === "loading";
  const matchingModels = fresh
    ? preview.models.filter((model) =>
        `${model.id} ${model.name ?? ""}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      )
    : [];
  const fetchModels = async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    const attempt = ++requestRef.current;
    setPreview({ connection, status: "loading", models: [], selected });
    setSearch("");
    const input = inputOf({
      id: provider?.id ?? "",
      name,
      kind,
      baseUrl,
      key,
      clearKey,
      headers,
      models: [],
    });
    try {
      const result = await discoverProviderModels({
        kind,
        baseUrl: input.baseUrl,
        ...(savedId === undefined
          ? {}
          : { id: savedId, ...(revision === undefined ? {} : { revision }) }),
        ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
        ...(input.headers === undefined ? {} : { headers: input.headers }),
      });
      if (attempt !== requestRef.current) return;
      setPreview((current) => ({
        connection,
        status: "ready",
        models: [
          ...new Map(result.models.map((model) => [model.id, model])).values(),
        ],
        selected: current?.selected ?? [],
      }));
    } catch (error) {
      if (attempt !== requestRef.current) return;
      const message = discoveryErrorMessage(error);
      setPreview((current) => ({
        connection,
        status: "failed",
        models: [],
        selected: current?.selected ?? [],
        error: message,
      }));
    } finally {
      if (attempt === requestRef.current) pendingRef.current = false;
    }
  };

  const id =
    savedId ??
    uniqueId(
      name,
      (config?.providers ?? []).map((existing) => existing.id),
    );
  const custom = isCustomKind(kind);
  const save = useSaveProvider();
  const submit = () => {
    metadataRequestRef.current += 1;
    metadataPendingRef.current = false;
    setMetadata(undefined);
    save.mutate(
      {
        provider: inputOf({
          id,
          name,
          kind,
          baseUrl,
          key,
          clearKey,
          headers,
          models: allModels,
        }),
        ...(revision === undefined ? {} : { revision }),
      },
      {
        onSuccess: (result) => {
          setSavedId(id);
          setModels(allModels);
          setPreview(undefined);
          setSaved(true);
          setChangedElsewhere(false);
          setKey("");
          setClearKey(false);
          setRevision(result.revision);
          setBaseline(
            fingerprint({
              name,
              kind,
              baseUrl,
              headers: Object.fromEntries(
                headers.map((row) => [row.name, row.value]),
              ),
              models: allModels,
              key: "",
              clearKey: false,
            }),
          );
        },
        onError: (error) => {
          if (isConfigChanged(error)) {
            // The host re-read the config before refusing: the next save is made against it.
            setRevision(currentRevision());
            setChangedElsewhere(true);
            return;
          }
          toast.error(providerErrorMessage(error));
        },
      },
    );
  };

  const close = () => {
    metadataRequestRef.current += 1;
    requestRef.current += 1;
    pendingRef.current = false;
    onClose();
  };
  const back = () => {
    if (dirty) {
      setDiscarding(true);
      return;
    }
    close();
  };

  const providerName = provider ? providerLabel(provider) : "";
  // Removing a provider takes its models away from the agents that use them.
  const affectedAgents = provider
    ? agents
        .filter((agent) => agent.model?.startsWith(`${provider.id}:`))
        .map((agent) =>
          translateText("common:format.quotedValue", { value: agent.name }),
        )
    : [];

  const patchModel = (index: number, patch: Partial<ModelRow>) => {
    const row = allModels[index]!;
    const edited = new Set(row.edited);
    if (patch.name !== undefined) edited.add("name");
    if (patch.contextWindow !== undefined) edited.add("contextWindow");
    if (patch.vision !== undefined) edited.add("input");
    patch = { ...patch, edited: [...edited] };
    if (index < models.length) {
      setModels((current) =>
        current.map((row, at) => (at === index ? { ...row, ...patch } : row)),
      );
    } else {
      const target = selected[index - models.length];
      setPreview((current) =>
        current === undefined
          ? current
          : {
              ...current,
              selected: current.selected.map((row) =>
                row === target ? { ...row, ...patch } : row,
              ),
            },
      );
    }
  };
  const removeModel = (index: number) => {
    if (index < models.length)
      setModels((current) => current.filter((_, at) => at !== index));
    else {
      const target = selected[index - models.length];
      setPreview((current) =>
        current === undefined
          ? current
          : {
              ...current,
              selected: current.selected.filter((row) => row !== target),
            },
      );
    }
  };

  return (
    <div>
      <div className="settings-back">
        <button type="button" onClick={back}>
          <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
          {translateText("common:actions.back")}
        </button>
      </div>
      <div className="settings-heading">
        <h2 className="font-mono">
          {provider?.id ?? translateText("editor.newTitle")}
        </h2>
        <p>{translateText("editor.description")}</p>
      </div>
      <fieldset className="min-w-0" disabled={save.isPending}>
        <div className="settings-field">
          <Label htmlFor="provider-name">{translateText("editor.name")}</Label>
          <Input
            id="provider-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="settings-field">
          <Label htmlFor="provider-kind">{translateText("editor.kind")}</Label>
          <Select
            id="provider-kind"
            value={kind}
            onValueChange={(next) => {
              setKind(next as ProviderKind);
              const preset = PRESETS.find(([kind]) => kind === next)?.[1];
              if (preset) setBaseUrl(preset.baseUrl);
            }}
          >
            {PRESETS.map(([choice, preset]) => (
              <SelectOption key={choice} value={choice}>
                {preset.name}
              </SelectOption>
            ))}
            <SelectOption value="openai-compatible">
              {translateText("editor.chatCompletions")}
            </SelectOption>
            <SelectOption value="openai-responses">
              {translateText("editor.responses")}
            </SelectOption>
          </Select>
          {custom ? (
            <p className="settings-hint">
              {translateText(
                kind === "openai-responses"
                  ? "editor.responsesHint"
                  : "editor.chatCompletionsHint",
              )}
            </p>
          ) : null}
          <p className="settings-hint">{translateText("editor.nativeCodex")}</p>
        </div>
        <div className="settings-field">
          <Label htmlFor="provider-base">
            {translateText("editor.baseUrl")}
          </Label>
          <Input
            id="provider-base"
            value={baseUrl}
            spellCheck={false}
            className="font-mono"
            onChange={(event) => setBaseUrl(event.target.value)}
          />
          <p className="settings-hint">{translateText("editor.baseUrlHint")}</p>
        </div>
        <div className="settings-field">
          <Label htmlFor="provider-key">{translateText("editor.key")}</Label>
          <Input
            id="provider-key"
            type="password"
            value={key}
            autoComplete="off"
            placeholder={
              provider?.hasApiKey === true
                ? translateText("editor.keyConfigured")
                : translateText("editor.keyMissing")
            }
            onChange={(event) => {
              setKey(event.target.value);
              if (event.target.value.length > 0) setClearKey(false);
            }}
          />
          {provider?.hasApiKey === true ? (
            <button
              type="button"
              className="settings-text-button justify-self-start text-left"
              onClick={() => {
                setClearKey((current) => !current);
                setKey("");
              }}
            >
              {clearKey
                ? translateText("editor.keepKey")
                : translateText("editor.clearKey")}
            </button>
          ) : null}
        </div>
        <details className="settings-headers" open={headers.length > 0}>
          <summary>{translateText("editor.headers")}</summary>
          {headers.map((row, at) => (
            <div key={at} className="settings-header-row">
              <Input
                aria-label={translateText("editor.headerName")}
                className="font-mono"
                placeholder="User-Agent"
                value={row.name}
                onChange={(event) =>
                  setHeaders((current) =>
                    current.map((candidate, index) =>
                      index === at
                        ? { ...candidate, name: event.target.value }
                        : candidate,
                    ),
                  )
                }
              />
              <Input
                aria-label={translateText("editor.headerValue")}
                className="font-mono"
                value={row.value}
                onChange={(event) =>
                  setHeaders((current) =>
                    current.map((candidate, index) =>
                      index === at
                        ? { ...candidate, value: event.target.value }
                        : candidate,
                    ),
                  )
                }
              />
              <button
                type="button"
                className="settings-text-button"
                aria-label={translateText("common:actions.delete")}
                onClick={() =>
                  setHeaders((current) =>
                    current.filter((_, index) => index !== at),
                  )
                }
              >
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            className="settings-text-button"
            onClick={() =>
              setHeaders((current) => [...current, { name: "", value: "" }])
            }
          >
            ＋ {translateText("editor.addHeader")}
          </button>
          <p className="settings-hint">{translateText("editor.headersHint")}</p>
        </details>
        <div className="settings-section-label">
          {translateText("editor.models")}
        </div>
        <div className="grid gap-2 mb-3">
          <Button
            type="button"
            variant="outline"
            className="justify-self-start"
            disabled={fetching || baseUrl.trim().length === 0 || save.isPending}
            onClick={() => void fetchModels()}
          >
            {fetching
              ? translateText("discovery.loading")
              : translateText("discovery.fetch")}
          </Button>
          <p className="settings-hint">{translateText("discovery.hint")}</p>
          {preview !== undefined &&
          !fresh &&
          !fetching &&
          preview.status !== "failed" ? (
            <p role="status" className="settings-hint">
              {translateText("discovery.stale")}
            </p>
          ) : null}
          {fetching ? (
            <p role="status" className="settings-hint">
              {translateText("discovery.loading")}
            </p>
          ) : null}
          {preview?.connection === connection && preview.status === "failed" ? (
            <p role="alert" className="settings-hint">
              {preview.error}
            </p>
          ) : null}
          {fresh ? (
            <>
              <Input
                aria-label={translateText("discovery.search")}
                placeholder={translateText("discovery.search")}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <div
                className="max-h-60 overflow-y-auto grid gap-1"
                aria-label={translateText("discovery.results")}
              >
                {matchingModels.map((model) => {
                  const existing = models.some(
                    (row) => row.id.trim() === model.id,
                  );
                  return (
                    <label key={model.id} className="settings-check break-all">
                      <input
                        type="checkbox"
                        checked={
                          existing ||
                          selected.some((row) => row.id === model.id)
                        }
                        disabled={existing}
                        onChange={(event) => {
                          const checked = event.target.checked;
                          setPreview((current) =>
                            current === undefined
                              ? current
                              : {
                                  ...current,
                                  selected: checked
                                    ? [...current.selected, rowOf(model)]
                                    : current.selected.filter(
                                        (row) => row.id !== model.id,
                                      ),
                                },
                          );
                        }}
                      />
                      <span>
                        {model.name ?? model.id}
                        {model.name && model.name !== model.id
                          ? ` · ${model.id}`
                          : ""}
                        {existing
                          ? ` · ${translateText("discovery.inForm")}`
                          : ""}
                      </span>
                    </label>
                  );
                })}
              </div>
              {preview.models.length === 0 ? (
                <p role="status" className="settings-hint">
                  {translateText("discovery.empty")}
                </p>
              ) : matchingModels.length === 0 ? (
                <p role="status" className="settings-hint">
                  {translateText("discovery.noMatches")}
                </p>
              ) : null}
            </>
          ) : null}
        </div>
        <div className="grid gap-2 mb-3">
          <Button
            type="button"
            variant="outline"
            className="justify-self-start"
            disabled={
              currentMetadata?.status === "loading" ||
              allModels.length === 0 ||
              !baseUrl.trim()
            }
            onClick={() => void supplementMetadata()}
          >
            {translateText(
              currentMetadata?.status === "loading"
                ? "metadata.loading"
                : "metadata.fetch",
            )}
          </Button>
          <p className="settings-hint">{translateText("metadata.hint")}</p>
          {currentMetadata?.status === "failed" ? (
            <p role="alert" className="settings-hint">
              {translateText("metadata.failed", {
                reason: currentMetadata.error,
              })}
            </p>
          ) : null}
          {currentMetadata?.status === "ready" ? (
            <p role="status" className="settings-hint">
              {translateText(
                currentMetadata.count ? "metadata.ready" : "metadata.empty",
                { count: currentMetadata.count },
              )}
            </p>
          ) : null}
        </div>
        {allModels.length === 0 ? (
          <p className="settings-hint">{translateText("editor.noModels")}</p>
        ) : null}
        {allModels.map((row, at) => (
          <ModelCard
            // Rows have no identity of their own until they have an id; the position is what the
            // person is looking at, and editing a field must not remount the card under the hand.
            key={at}
            index={at}
            row={row}
            onUpdate={(patch) => patchModel(at, patch)}
            onRemove={() => removeModel(at)}
          />
        ))}
        <button
          type="button"
          className="settings-add-model"
          onClick={() =>
            setModels((current) => [
              ...current,
              {
                id: "",
                name: "",
                contextWindow: "",
                vision: false,
                reasoning: false,
                defaultThinking: undefined,
              },
            ])
          }
        >
          ＋ {translateText("editor.addModel")}
        </button>
      </fieldset>
      <div className="settings-provider-actions">
        {changedElsewhere ? (
          <p
            role="alert"
            className="border border-state-warning px-2 py-1 text-xs"
          >
            {translateText("errors.configChanged")}
          </p>
        ) : null}
        {discarding ? (
          <div
            role="alertdialog"
            aria-label={translateText("editor.unsaved")}
            className="flex flex-wrap items-center gap-2 border border-state-warning px-2 py-1.5 text-xs"
          >
            <span className="min-w-0 flex-1">
              {translateText("editor.unsaved")}
            </span>
            <Button
              size="xs"
              variant="outline"
              onClick={() => setDiscarding(false)}
            >
              {translateText("common:actions.cancel")}
            </Button>
            <Button
              size="xs"
              onClick={() => {
                setDiscarding(false);
                close();
              }}
            >
              {translateText("editor.discard")}
            </Button>
          </div>
        ) : null}
        <div className="settings-save">
          {provider ? (
            <button
              type="button"
              className="settings-danger"
              disabled={remove.isPending}
              onClick={() => setRemoving(true)}
            >
              {translateText("common:actions.delete")}
            </button>
          ) : (
            <span />
          )}
          <span role="status">
            {dirty
              ? translateText("editor.unsaved")
              : saved
                ? translateText("common:feedback.saved")
                : ""}
          </span>
          <Button
            className="settings-primary"
            onClick={submit}
            disabled={
              save.isPending ||
              config === undefined ||
              id.length === 0 ||
              baseUrl.trim().length === 0
            }
          >
            {translateText("common:actions.save")}
          </Button>
        </div>
      </div>
      {provider ? (
        <AlertDialog open={removing} onOpenChange={setRemoving}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {translateText("remove.confirmTitle", { providerName })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {affectedAgents.length
                  ? translateText("remove.affectedAgents", {
                      agents: affectedAgents.join(listSeparator()),
                      providerName,
                    })
                  : translateText("remove.credentialsNotice")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                {translateText("common:actions.cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() =>
                  remove.mutate(provider.id, {
                    onSuccess: () => {
                      toast.success(
                        translateText("remove.success", { providerName }),
                      );
                      onClose();
                    },
                    onError: (error) =>
                      toast.error(providerErrorMessage(error)),
                  })
                }
              >
                {translateText("common:actions.remove")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
}
