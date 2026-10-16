import { useState } from "react";
import { useTranslation } from "react-i18next";
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
import { useEmbeddingModels } from "@/queries/llm";
import {
  gatewayEmbedder,
  isRebuilding,
  LOCAL_EMBEDDER,
  useCancelEmbeddingRebuild,
  useMemoryEmbedding,
  useSetMemoryEmbedding,
} from "@/queries/memory";
import { Select, SelectOption } from "./select-field";

/**
 * Settings → 模型服务 → 记忆 embedding: which model embeds the agents'
 * memories. Switching re-embeds every memory in the background; recall and
 * saving keep working on the current model until it is done.
 */
export function MemoryEmbeddingSettings() {
  const { t: translateText } = useTranslation(["providers", "common"] as const);
  const embedding = useMemoryEmbedding();
  const { data: models } = useEmbeddingModels();
  const setEmbedding = useSetMemoryEmbedding();
  const cancel = useCancelEmbeddingRebuild();
  const [target, setTarget] = useState<string>();
  const headingId = "memory-embedding";

  const name = (model: string) =>
    model === LOCAL_EMBEDDER
      ? translateText("embedding.local")
      : (models?.find((m) => gatewayEmbedder(m.id) === model)?.display_name ??
        model.replace(/^gateway:/, ""));

  const data = embedding.data;
  const rebuild = data?.rebuild;
  const rebuilding = isRebuilding(data);

  return (
    <section aria-labelledby={headingId} className="space-y-1.5">
      <h3 id={headingId} className="text-sm font-medium">
        {translateText("embedding.title")}
      </h3>
      {embedding.error ? (
        <p role="alert" className="text-xs text-destructive">
          {translateText("embedding.loadFailed", {
            message: embedding.error.message,
          })}
        </p>
      ) : null}
      {data ? (
        <Select
          aria-labelledby={headingId}
          className="w-full"
          value={data.space.model}
          disabled={setEmbedding.isPending}
          onValueChange={(model) => {
            if (model !== data.space.model) setTarget(model);
          }}
        >
          <SelectOption value={LOCAL_EMBEDDER}>
            {name(LOCAL_EMBEDDER)}
          </SelectOption>
          {(models ?? []).map((model) => (
            <SelectOption
              key={model.id}
              value={gatewayEmbedder(model.id)}
              disabled={!model.available}
            >
              {model.available
                ? model.display_name
                : translateText("embedding.unavailableModel", {
                    name: model.display_name,
                    reason:
                      model.reason?.message ??
                      translateText("embedding.linkGemini"),
                  })}
            </SelectOption>
          ))}
        </Select>
      ) : null}
      {rebuild && rebuild.status !== "done" ? (
        <div className="space-y-1 text-xs">
          {rebuilding ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">
                  {translateText("embedding.progress", {
                    name: name(rebuild.model),
                    done: rebuild.done,
                    total: rebuild.total,
                  })}
                </span>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={cancel.isPending}
                  onClick={() => cancel.mutate()}
                >
                  {translateText("embedding.cancelRebuild")}
                </Button>
              </div>
              <div
                role="progressbar"
                aria-label={translateText("embedding.progressLabel")}
                aria-valuemin={0}
                aria-valuemax={rebuild.total}
                aria-valuenow={rebuild.done}
                className="h-1.5 bg-muted"
              >
                <div
                  className="h-full bg-foreground/70"
                  style={{
                    width: `${rebuild.total ? (100 * rebuild.done) / rebuild.total : 0}%`,
                  }}
                />
              </div>
            </>
          ) : null}
          {rebuild.status === "paused" || rebuild.status === "failed" ? (
            <p role="alert" className="text-destructive">
              {translateText(
                rebuild.status === "paused"
                  ? "embedding.paused"
                  : "embedding.failed",
                { name: name(rebuild.model), error: rebuild.error ?? "" },
              )}
            </p>
          ) : null}
        </div>
      ) : null}
      {setEmbedding.error ? (
        <p role="alert" className="text-xs text-destructive">
          {setEmbedding.error.message}
        </p>
      ) : null}
      <AlertDialog
        open={target !== undefined}
        onOpenChange={(open) => !open && setTarget(undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {translateText("embedding.confirmTitle", {
                name: target ? name(target) : "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {translateText("embedding.confirmDescription", {
                count: data?.memories ?? 0,
              })}
              {target && target !== LOCAL_EMBEDDER
                ? translateText("embedding.quotaNotice")
                : null}
              {rebuilding ? translateText("embedding.replacesRebuild") : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {translateText("common:actions.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (target) setEmbedding.mutate(target);
                setTarget(undefined);
              }}
            >
              {translateText("embedding.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
