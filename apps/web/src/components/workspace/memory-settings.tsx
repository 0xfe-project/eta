import { useId, useState } from "react";
import { toast } from "sonner";
import { LoadError, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useBundleConfig, useSetBundleConfig } from "@/queries/bundle-config";
import { useBundles } from "@/queries/chat";

const URL_KEY = "MEMORY_EMBEDDING_URL";
const MODEL_KEY = "MEMORY_EMBEDDING_MODEL";
const API_KEY = "MEMORY_EMBEDDING_API_KEY";

function MemoryForm({
  values,
  secretSet,
}: {
  values: Record<string, string>;
  secretSet: boolean;
}) {
  const id = useId();
  const save = useSetBundleConfig("memory");
  const [mode, setMode] = useState(values[URL_KEY] ? "api" : "local");
  const [url, setURL] = useState(values[URL_KEY] ?? "");
  const [model, setModel] = useState(values[MODEL_KEY] ?? "");
  const [apiKey, setAPIKey] = useState("");
  const [clearKey, setClearKey] = useState(false);

  return (
    <form
      className="max-w-lg space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        const changes: Record<string, string | null> = {
          [URL_KEY]: mode === "api" ? url.trim() : null,
        };
        if (mode === "api") {
          changes[MODEL_KEY] = model.trim();
          if (apiKey.trim()) changes[API_KEY] = apiKey.trim();
        }
        if (clearKey && !apiKey.trim()) changes[API_KEY] = null;
        save.mutate(changes, {
          onSuccess: () => toast.success("已保存，记忆服务正在更新"),
          onError: (error) => toast.error(error.message),
        });
      }}
    >
      <div className="space-y-1">
        <Label htmlFor={`${id}-mode`}>向量模型</Label>
        <Select value={mode} onValueChange={setMode}>
          <SelectTrigger id={`${id}-mode`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="local">本地模型（INT8）</SelectItem>
            <SelectItem value="api">外部 API</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {mode === "api" ? (
        <>
          <div className="space-y-1">
            <Label htmlFor={`${id}-url`}>API 地址</Label>
            <Input
              id={`${id}-url`}
              type="url"
              value={url}
              placeholder="https://example.com/v1"
              required
              maxLength={2048}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setURL(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              支持 OpenAI 兼容的 embeddings 接口。
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-model`}>模型</Label>
            <Input
              id={`${id}-model`}
              value={model}
              required
              maxLength={200}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setModel(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-key`}>API key（可选）</Label>
            <Input
              id={`${id}-key`}
              type="password"
              value={apiKey}
              placeholder={
                clearKey
                  ? "保存后清除"
                  : secretSet
                    ? "已设置，留空不替换"
                    : undefined
              }
              maxLength={4096}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setAPIKey(event.target.value);
                setClearKey(false);
              }}
            />
            {secretSet && !clearKey ? (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => {
                  setAPIKey("");
                  setClearKey(true);
                }}
              >
                清除密钥
              </Button>
            ) : null}
          </div>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          Jina 中英向量模型，在服务器上离线运行。
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        切换模型后会重建记忆索引，完成后生效。
      </p>
      <Button type="submit" disabled={save.isPending}>
        {save.isPending ? "正在保存…" : "保存"}
      </Button>
    </form>
  );
}

export function MemorySettings() {
  const { data, error, refetch } = useBundleConfig("memory");
  const bundles = useBundles(5000);
  const status = bundles.data?.find(
    (bundle) => bundle.name === "memory",
  )?.service_status;
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold">记忆</h2>
      {status ? (
        <p className="text-xs text-muted-foreground" role="status">
          {status.state === "ready"
            ? "服务运行中"
            : status.state === "applying"
              ? "服务更新中"
              : status.message || "记忆服务暂不可用"}
        </p>
      ) : null}
      {error ? (
        <LoadError
          what="记忆设置"
          error={error}
          onRetry={() => void refetch()}
        />
      ) : data ? (
        <MemoryForm
          key={data.updated_at ?? "new"}
          values={data.values}
          secretSet={data.set.includes(API_KEY)}
        />
      ) : (
        <Loading rows={3} />
      )}
    </div>
  );
}
