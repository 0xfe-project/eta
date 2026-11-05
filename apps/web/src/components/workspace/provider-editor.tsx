import type {
  EtaModelConfig,
  ModelCapabilities,
  ProviderInput,
  ProviderKind,
  ProviderSummary,
} from "@eta/client-contracts";
/**
 * Editing one provider, in place: the settings column turns into this form and 返回 brings the list
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
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { useState } from "react";
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
  isConfigChanged,
  providerErrorMessage,
  providerLabel,
  useDeleteProvider,
  useProviders,
  useSaveProvider,
} from "@/queries/providers";
import { Select, SelectOption } from "./select-field";
import { useAgents } from "./use-agents";

const KINDS: ProviderKind[] = [
  "openai-compatible",
  "openai-responses",
  "openai-codex",
  "kimi-coding",
  "deepseek",
  "zai-coding-cn",
  "zai",
];

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
  if (row.vision !== (was?.input?.includes("image") ?? false))
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
  custom,
  onUpdate,
  onRemove,
}: {
  row: ModelRow;
  index: number;
  custom: boolean;
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
      {custom ? (
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
      ) : null}
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
    ]),
  ]);
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
  const [kind, setKind] = useState<ProviderKind>(provider?.kind ?? KINDS[0]!);
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
  const [changedElsewhere, setChangedElsewhere] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  // The config this form was read from: what a save has to be made against.
  const [revision, setRevision] = useState(config?.revision);

  // A dirty form is one the person would lose by leaving it, so 返回 asks first — the rule the whole
  // settings dialog follows, applied to the one form here that can hold an unsubmitted key. The
  // form is compared against what was last read or written, not against the row behind it: after a
  // save the row follows, and a form that flickered back to "unsaved" while it did would be wrong.
  const [baseline, setBaseline] = useState(() =>
    fingerprint({
      name: provider?.name ?? "",
      kind: provider?.kind ?? KINDS[0]!,
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
  const dirty = current !== baseline;

  const id =
    provider?.id ??
    uniqueId(
      name,
      (config?.providers ?? []).map((existing) => existing.id),
    );
  const custom = isCustomKind(kind);
  const save = useSaveProvider();
  const submit = () =>
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
          models,
        }),
        ...(revision === undefined ? {} : { revision }),
      },
      {
        onSuccess: (result) => {
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
              models,
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

  const back = () => {
    if (dirty) {
      setDiscarding(true);
      return;
    }
    onClose();
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

  const patchModel = (index: number, patch: Partial<ModelRow>) =>
    setModels((current) =>
      current.map((row, at) => (at === index ? { ...row, ...patch } : row)),
    );

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
      <fieldset className="min-w-0">
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
            onValueChange={(next) => setKind(next as ProviderKind)}
          >
            {KINDS.map((choice) => (
              <SelectOption key={choice} value={choice}>
                <span className="font-mono">{choice}</span>
              </SelectOption>
            ))}
          </Select>
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
        {models.length === 0 ? (
          <p className="settings-hint">{translateText("editor.noModels")}</p>
        ) : null}
        {models.map((row, at) => (
          <ModelCard
            // Rows have no identity of their own until they have an id; the position is what the
            // person is looking at, and editing a field must not remount the card under the hand.
            key={at}
            index={at}
            row={row}
            custom={custom}
            onUpdate={(patch) => patchModel(at, patch)}
            onRemove={() =>
              setModels((current) => current.filter((_, index) => index !== at))
            }
          />
        ))}
        {custom ? (
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
        ) : null}
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
                onClose();
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
