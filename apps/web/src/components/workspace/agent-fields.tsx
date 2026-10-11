import type { UseFormReturn } from "react-hook-form";
import type { AgentForm } from "./agent-form";
import type { Bundle } from "@/queries/chat";
import type { Model } from "@/queries/llm";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useConnectors } from "@/queries/llm";
import { DESCRIPTION_MAX } from "./agent-form";
import { Select, SelectGroup, SelectOption } from "./select-field";

type Form = UseFormReturn<AgentForm>;

/** Models grouped by service; unusable ones stay visible but disabled. */
export function ModelSelect({
  value,
  models,
  invalid,
  ...props
}: Omit<React.ComponentProps<typeof Select>, "children"> & {
  value: string;
  /** Undefined while they load. */
  models: Model[] | undefined;
  invalid?: boolean;
}) {
  const { data: connectors } = useConnectors();
  const loading = !models || !connectors;
  const groups = (connectors ?? []).map((connector) => ({
    connector,
    models: (models ?? []).filter((model) => model.connector === connector.id),
  }));
  const known = (models ?? []).some((model) => model.id === value);
  return (
    <Select
      className="w-full"
      aria-invalid={invalid}
      value={value}
      {...props}
      disabled={loading || props.disabled}
    >
      <SelectOption value="" disabled>
        {loading ? "正在加载模型…" : "选择模型"}
      </SelectOption>
      {value && !known ? (
        <SelectOption value={value} disabled>
          {loading ? "正在加载模型…" : `${value}（已不存在）`}
        </SelectOption>
      ) : null}
      {groups
        .filter((group) => group.models.length)
        .map(({ connector, models }) => (
          <SelectGroup key={connector.id} label={connector.display_name}>
            {models.map((model) => (
              <SelectOption
                key={model.id}
                value={model.id}
                disabled={!model.available && model.id !== value}
              >
                {model.display_name}
                {model.available ? "" : "（不可用）"}
              </SelectOption>
            ))}
          </SelectGroup>
        ))}
    </Select>
  );
}

/** One checkbox per bundle; built-in ones first. */
function BundleList({
  value,
  bundles,
  autoFocus,
  onChange,
}: {
  value: string[] | null;
  bundles: Bundle[];
  autoFocus?: boolean;
  onChange: (value: string[]) => void;
}) {
  const names = bundles.map((bundle) => bundle.name);
  const chosen =
    value ?? bundles.filter((bundle) => bundle.builtin).map((b) => b.name);
  const toggle = (name: string, on: boolean) =>
    onChange(names.filter((n) => (n === name ? on : chosen.includes(n))));
  return (
    <ul className="grid grid-cols-2 gap-2">
      {bundles.map((bundle, index) => {
        const on = chosen.includes(bundle.name);
        return (
          <li key={bundle.name} className="flex">
            {/* A card per bundle, as in choosing where GitHub's App lives. */}
            <Label
              className={cn(
                "flex-1 cursor-pointer items-start gap-2.5 border p-3 leading-snug transition-colors duration-[60ms] ease-linear hover:bg-muted/50 has-focus-visible:ring-1 has-focus-visible:ring-ring",
                on && "border-foreground bg-muted/50",
              )}
            >
              <Checkbox
                className="mt-px"
                autoFocus={autoFocus && index === 0}
                checked={on}
                onCheckedChange={(next) => toggle(bundle.name, next === true)}
              />
              <span className="min-w-0 space-y-0.5">
                <span className="block font-medium break-words">
                  {bundle.name}
                  {bundle.builtin ? null : (
                    <span className="ml-1.5 font-normal text-muted-foreground">
                      自定义
                    </span>
                  )}
                </span>
                {bundle.description ? (
                  <span className="block text-muted-foreground">
                    {bundle.description}
                  </span>
                ) : null}
              </span>
            </Label>
          </li>
        );
      })}
    </ul>
  );
}

export function NameField({
  form,
  autoFocus,
}: {
  form: Form;
  autoFocus?: boolean;
}) {
  const error = form.formState.errors.name;
  return (
    <div className="space-y-1.5">
      <Label htmlFor="agent-name">名称</Label>
      <Input
        id="agent-name"
        autoFocus={autoFocus}
        placeholder="例如：代码审查"
        aria-invalid={Boolean(error)}
        aria-describedby={error ? "agent-name-error" : undefined}
        {...form.register("name")}
      />
      {error ? (
        <p
          id="agent-name-error"
          role="alert"
          className="text-xs text-destructive"
        >
          {error.message}
        </p>
      ) : null}
    </div>
  );
}

export function ModelField({
  form,
  models,
  onOpenProviders,
}: {
  form: Form;
  /** Undefined while they load. */
  models: Model[] | undefined;
  onOpenProviders: () => void;
}) {
  const error = form.formState.errors.model;
  // Only once they have loaded can there be none.
  const noModels =
    models !== undefined && !models.some((model) => model.available);
  return (
    <div className="space-y-1.5">
      <Label htmlFor="agent-model">模型</Label>
      <ModelSelect
        id="agent-model"
        value={form.watch("model")}
        models={models}
        invalid={Boolean(error)}
        aria-describedby={error || noModels ? "agent-model-hint" : undefined}
        onValueChange={(value) =>
          form.setValue("model", value, {
            shouldDirty: true,
            shouldValidate: true,
          })
        }
      />
      {error || noModels ? (
        <p
          id="agent-model-hint"
          role={error ? "alert" : undefined}
          className={
            error ? "text-xs text-destructive" : "text-xs text-muted-foreground"
          }
        >
          {error?.message ?? "暂无可用模型。"}
          {noModels ? (
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto px-1"
              onClick={onOpenProviders}
            >
              前往模型服务
            </Button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

export function BundlesField({
  form,
  bundles,
  autoFocus,
}: {
  form: Form;
  bundles: Bundle[];
  autoFocus?: boolean;
}) {
  return (
    <div
      role="group"
      aria-labelledby="agent-bundles"
      aria-describedby="agent-bundles-hint"
      className="space-y-1.5"
    >
      <p id="agent-bundles" className="text-xs leading-none">
        环境包
      </p>
      <BundleList
        value={form.watch("bundles")}
        bundles={bundles}
        autoFocus={autoFocus}
        onChange={(value) =>
          form.setValue("bundles", value, { shouldDirty: true })
        }
      />
      <p id="agent-bundles-hint" className="text-xs text-muted-foreground">
        智能体的环境由这些环境包构建：安装的工具、可用的插件。修改后重新构建，在空闲时生效。
      </p>
    </div>
  );
}

export function InstructionsField({
  form,
  autoFocus,
}: {
  form: Form;
  autoFocus?: boolean;
}) {
  const error = form.formState.errors.description;
  const length = form.watch("description").length;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor="agent-description">指令</Label>
        <span
          className="text-xs tabular-nums text-muted-foreground"
          aria-live="polite"
        >
          {length.toLocaleString()} / {DESCRIPTION_MAX.toLocaleString()}
        </span>
      </div>
      <Textarea
        id="agent-description"
        rows={12}
        autoFocus={autoFocus}
        className="max-h-[50dvh] min-h-48 font-mono leading-relaxed"
        placeholder="职责、工作方式和约束。例如：你负责审查 Pull Request，只指出会导致错误的问题。"
        aria-invalid={Boolean(error)}
        aria-describedby="agent-description-hint"
        {...form.register("description")}
      />
      <p
        id="agent-description-hint"
        className={
          error ? "text-xs text-destructive" : "text-xs text-muted-foreground"
        }
        role={error ? "alert" : undefined}
      >
        {error?.message ??
          "注入智能体的上下文；修改在空闲时生效，不打断进行中的回复。"}
      </p>
    </div>
  );
}
