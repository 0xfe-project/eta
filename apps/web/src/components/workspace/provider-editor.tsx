import type { ProviderView } from "@/queries/providers";
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
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
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

const KINDS = [
  "openai-compatible",
  "openai-codex",
  "kimi-coding",
  "deepseek",
  "zai-coding-cn",
  "zai",
];

/** What the form submits. `apiKey` is absent unless the field was typed into or cleared. */
export interface ProviderPatch {
  name?: string;
  kind?: string;
  baseUrl?: string;
  apiKey?: string | null;
  headers?: Record<string, string | null>;
  models?: {
    id: string;
    name?: string;
    contextWindow?: number;
    input?: string[];
  }[];
}

function buildPatch(input: {
  name: string;
  kind: string;
  baseUrl: string;
  key: string;
  clearKey: boolean;
  headers: { name: string; value: string }[];
  models: {
    id: string;
    name: string;
    contextWindow: string;
    vision: boolean;
  }[];
}): ProviderPatch {
  const patch: ProviderPatch = {
    name: input.name.trim(),
    kind: input.kind,
    baseUrl: input.baseUrl.trim(),
    headers: Object.fromEntries(
      input.headers
        .map((row) => [row.name.trim(), row.value.trim()] as const)
        .filter(([name]) => name.length > 0)
        .map(([name, value]) => [name, value.length === 0 ? null : value]),
    ),
    models: input.models
      .filter((model) => model.id.trim().length > 0)
      .map((model) => ({
        id: model.id.trim(),
        ...(model.name.trim().length === 0 ? {} : { name: model.name.trim() }),
        ...(Number.isFinite(Number(model.contextWindow)) &&
        model.contextWindow.trim().length > 0
          ? { contextWindow: Number(model.contextWindow) }
          : {}),
        input: model.vision ? ["text", "image"] : ["text"],
      })),
  };
  // Absent means "leave it alone"; null means "take it away". An untouched field must not erase
  // the key just because the form had nothing to put in it.
  if (input.clearKey) patch.apiKey = null;
  else if (input.key.trim().length > 0) patch.apiKey = input.key.trim();
  return patch;
}

export function ProviderEditor({
  provider,
  open,
  onOpenChange,
}: {
  provider: ProviderView | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t: translateText } = useTranslation(["providers", "common"] as const);
  const client = useQueryClient();
  const [name, setName] = useState(provider?.name ?? "");
  const [kind, setKind] = useState(provider?.kind ?? KINDS[0]!);
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [headers, setHeaders] = useState(
    Object.entries(provider?.headers ?? {}).map(([headerName, value]) => ({
      name: headerName,
      value: value ?? "",
    })),
  );
  const [models, setModels] = useState(
    (provider?.models ?? []).map((model) => ({
      id: model.id,
      name: model.name ?? "",
      contextWindow:
        model.context_window === null ? "" : String(model.context_window),
      vision: model.input.includes("image"),
    })),
  );
  const [saved, setSaved] = useState(false);
  const [discarding, setDiscarding] = useState(false);

  // What the form started as. A dirty form is one the person would lose by closing it, so closing
  // asks first — the rule the whole settings dialog follows, applied to the one form here that can
  // hold an unsubmitted key.
  const initial = {
    name: provider?.name ?? "",
    kind: provider?.kind ?? KINDS[0]!,
    baseUrl: provider?.baseUrl ?? "",
    headers: JSON.stringify(provider?.headers ?? {}),
    models: JSON.stringify(provider?.models ?? []),
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
    ) !==
      JSON.stringify(
        (provider?.models ?? []).map((model) => [
          model.id,
          model.name ?? "",
          model.context_window === null ? "" : String(model.context_window),
          model.input.includes("image"),
        ]),
      );

  const save = useMutation({
    mutationFn: async (patch: ProviderPatch) => {
      const id = provider?.id ?? name.trim().toLowerCase().replace(/\s+/g, "-");
      const response = await fetch(
        `/api/llm/v1/providers/${encodeURIComponent(id)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        },
      );
      const body = (await response.json().catch(() => null)) as {
        restart_required?: boolean;
        error?: { message?: string };
      } | null;
      if (!response.ok) throw new Error(body?.error?.message ?? "保存失败");
      return body?.restart_required === true;
    },
    onSuccess: (restartRequired) => {
      setSaved(restartRequired);
      setKey("");
      void client.invalidateQueries({ queryKey: ["llm", "providers"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

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
            <Select value={kind} onValueChange={setKind}>
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
                provider?.has_key === true
                  ? translateText("editor.keyConfigured")
                  : translateText("editor.keyMissing")
              }
              onChange={(event) => {
                setKey(event.target.value);
                if (event.target.value.length > 0) setClearKey(false);
              }}
            />
            {provider?.has_key === true ? (
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
            onClick={() =>
              save.mutate(
                buildPatch({
                  name,
                  kind,
                  baseUrl,
                  key,
                  clearKey,
                  headers,
                  models,
                }),
              )
            }
            disabled={save.isPending || baseUrl.trim().length === 0}
          >
            {translateText("common:actions.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
