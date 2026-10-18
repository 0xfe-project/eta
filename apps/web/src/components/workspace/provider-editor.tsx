import type {
  EtaModelConfig,
  ModelCapabilities,
  ProviderInput,
  ProviderKind,
  ProviderSummary,
} from "@eta/client-contracts";
/**
 * Editing one provider: what it is, where it points, how it authenticates, and what it can run.
 *
 * The form is written against what the host can actually do, and that has one sharp edge: a change
 * is saved to `config.json` and takes effect on the next start, because providers are built once at
 * startup and handed to sessions. So saving says so — a form that looks like it took effect and did
 * not is worse than one that admits it needs a restart.
 *
 * The key field starts empty and says whether a key is configured: an editor can replace one
 * without ever being shown it.
 *
 * A save carries the revision of the config this form was read from. If the config changed since
 * (another tab, an editor on the file), the host refuses, the page re-reads it, and the person is
 * told to look again before saving once more.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  currentRevision,
  isConfigChanged,
  providerErrorMessage,
  useProviders,
  useSaveProvider,
} from "@/queries/providers";

const KINDS: ProviderKind[] = [
  "openai-compatible",
  "openai-responses",
  "openai-codex",
  "kimi-coding",
  "deepseek",
  "zai-coding-cn",
  "zai",
];

/** One model in the form: what can be edited, and the config entry it came from. */
interface ModelRow {
  id: string;
  name: string;
  contextWindow: string;
  vision: boolean;
  source?: EtaModelConfig;
}

function rowOf(model: EtaModelConfig): ModelRow {
  return {
    id: model.id,
    name: model.name ?? "",
    contextWindow:
      model.contextWindow === undefined ? "" : String(model.contextWindow),
    vision: model.input?.includes("image") ?? false,
    source: model,
  };
}

/**
 * The entry a row saves as. Everything the form does not show (reasoning, thinking levels, token
 * limits) stays as it was, and what the person changed goes in `overrides`, which discovery keeps.
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
  return {
    ...was,
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

export function ProviderEditor({
  provider,
  open,
  onOpenChange,
}: {
  provider: ProviderSummary | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t: translateText } = useTranslation(["providers", "common"] as const);
  const { data: config } = useProviders();
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

  // What the form started as. A dirty form is one the person would lose by closing it, so closing
  // asks first — the rule the whole settings dialog follows, applied to the one form here that can
  // hold an unsubmitted key.
  const initial = {
    name: provider?.name ?? "",
    kind: provider?.kind ?? KINDS[0]!,
    baseUrl: provider?.baseUrl ?? "",
    headers: JSON.stringify(provider?.headers ?? {}),
    models: JSON.stringify(
      (provider?.models ?? []).map((model) => {
        const row = rowOf(model);
        return [row.id, row.name, row.contextWindow, row.vision];
      }),
    ),
  };
  const dirty =
    key.length > 0 ||
    clearKey ||
    name !== initial.name ||
    kind !== initial.kind ||
    baseUrl !== initial.baseUrl ||
    JSON.stringify(
      Object.fromEntries(headers.map((row) => [row.name, row.value])),
    ) !== initial.headers ||
    JSON.stringify(
      models.map((model) => [
        model.id,
        model.name,
        model.contextWindow,
        model.vision,
      ]),
    ) !== initial.models;

  const id =
    provider?.id ??
    uniqueId(
      name,
      (config?.providers ?? []).map((existing) => existing.id),
    );
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

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && dirty && !saved) {
          setDiscarding(true);
          return;
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono">
            {provider?.id ?? translateText("editor.newTitle")}
          </DialogTitle>
          <DialogDescription>
            {translateText("editor.description")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label htmlFor="provider-name">
              {translateText("editor.name")}
            </Label>
            <Input
              id="provider-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="provider-kind">
              {translateText("editor.kind")}
            </Label>
            <Select
              value={kind}
              onValueChange={(next) => setKind(next as ProviderKind)}
            >
              <SelectTrigger id="provider-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KINDS.map((choice) => (
                  <SelectItem key={choice} value={choice}>
                    <span className="font-mono">{choice}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
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
          <div className="grid gap-1">
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
                className="justify-self-start text-xs text-muted-foreground underline"
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
          <div className="grid gap-1">
            <Label>{translateText("editor.headers")}</Label>
            {headers.map((row, at) => (
              <div key={at} className="flex gap-1">
                <Input
                  aria-label={translateText("editor.headerName")}
                  value={row.name}
                  className="w-40 font-mono"
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
                  value={row.value}
                  className="min-w-0 flex-1 font-mono"
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
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={translateText("common:actions.delete")}
                  onClick={() =>
                    setHeaders((current) =>
                      current.filter((_, index) => index !== at),
                    )
                  }
                >
                  ×
                </Button>
              </div>
            ))}
            <Button
              size="xs"
              variant="outline"
              className="justify-self-start"
              onClick={() =>
                setHeaders((current) => [...current, { name: "", value: "" }])
              }
            >
              {translateText("editor.addHeader")}
            </Button>
          </div>
          <div className="grid gap-1">
            <Label>{translateText("editor.models")}</Label>
            {models.map((model, at) => (
              <div key={at} className="flex flex-wrap items-center gap-1">
                <Input
                  aria-label={translateText("editor.modelId")}
                  value={model.id}
                  placeholder="model-id"
                  className="w-44 font-mono"
                  onChange={(event) =>
                    setModels((current) =>
                      current.map((candidate, index) =>
                        index === at
                          ? { ...candidate, id: event.target.value }
                          : candidate,
                      ),
                    )
                  }
                />
                <Input
                  aria-label={translateText("editor.modelName")}
                  value={model.name}
                  className="min-w-0 flex-1"
                  onChange={(event) =>
                    setModels((current) =>
                      current.map((candidate, index) =>
                        index === at
                          ? { ...candidate, name: event.target.value }
                          : candidate,
                      ),
                    )
                  }
                />
                <Input
                  aria-label={translateText("editor.contextWindow")}
                  value={model.contextWindow}
                  inputMode="numeric"
                  className="w-24 font-mono"
                  onChange={(event) =>
                    setModels((current) =>
                      current.map((candidate, index) =>
                        index === at
                          ? { ...candidate, contextWindow: event.target.value }
                          : candidate,
                      ),
                    )
                  }
                />
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={model.vision}
                    onChange={(event) =>
                      setModels((current) =>
                        current.map((candidate, index) =>
                          index === at
                            ? { ...candidate, vision: event.target.checked }
                            : candidate,
                        ),
                      )
                    }
                  />
                  {translateText("editor.vision")}
                </label>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={translateText("common:actions.delete")}
                  onClick={() =>
                    setModels((current) =>
                      current.filter((_, index) => index !== at),
                    )
                  }
                >
                  ×
                </Button>
              </div>
            ))}
            <Button
              size="xs"
              variant="outline"
              className="justify-self-start"
              onClick={() =>
                setModels((current) => [
                  ...current,
                  { id: "", name: "", contextWindow: "", vision: false },
                ])
              }
            >
              {translateText("editor.addModel")}
            </Button>
          </div>
          {saved ? (
            <p
              role="status"
              className="border border-state-warning px-2 py-1 text-xs"
            >
              {translateText("editor.restartRequired")}
            </p>
          ) : null}
          {changedElsewhere ? (
            <p
              role="alert"
              className="border border-state-warning px-2 py-1 text-xs"
            >
              {translateText("errors.configChanged")}
            </p>
          ) : null}
        </div>
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
                onOpenChange(false);
              }}
            >
              {translateText("editor.discard")}
            </Button>
          </div>
        ) : null}
        <DialogFooter>
          <Button
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
