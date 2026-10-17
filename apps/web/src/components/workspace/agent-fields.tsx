import type { UseFormReturn } from "react-hook-form";
import type { AgentForm } from "./agent-form";
import type { Bundle } from "@/queries/chat";
import type { Model } from "@/queries/llm";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatLocale } from "@/lib/i18n";
import { translateBundleDescription } from "@/lib/i18n-metadata";
import { cn } from "@/lib/utils";
import { useConnectors } from "@/queries/llm";
import { DESCRIPTION_MAX } from "./agent-form";
import { usePersonas } from "./persona-cards";
import { Select, SelectGroup, SelectOption } from "./select-field";
import { useWorkspaceStore } from "./workspace-store";

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
  const { t: translateText } = useTranslation([
    "agents",
    "bundles",
    "common",
    "providers",
  ] as const);
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
        {loading
          ? translateText("models.loading")
          : translateText("models.select")}
      </SelectOption>
      {value && !known ? (
        <SelectOption value={value} disabled>
          {loading
            ? translateText("models.loading")
            : translateText("models.deletedOption", { modelName: value })}
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
                {model.status === "unavailable"
                  ? translateText("common:status.unavailableSuffix")
                  : model.status === "degraded"
                    ? translateText("providers:status.degradedSuffix")
                    : ""}
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
  const { t: translateText } = useTranslation([
    "agents",
    "bundles",
    "common",
    "providers",
  ] as const);
  const names = bundles.map((bundle) => bundle.name);
  const chosen =
    value ?? bundles.filter((bundle) => bundle.builtin).map((b) => b.name);
  const toggle = (name: string, on: boolean) =>
    onChange(names.filter((n) => (n === name ? on : chosen.includes(n))));
  return (
    <ul className="grid grid-cols-2 gap-2">
      {bundles.map((bundle, index) => {
        const on = bundle.required || chosen.includes(bundle.name);
        return (
          <li key={bundle.name} className="flex">
            {/* A card per bundle, as in choosing where GitHub's App lives. */}
            <Label
              className={cn(
                "flex-1 cursor-pointer items-start gap-2.5 border p-3 leading-snug duration-[60ms] ease-linear hover:bg-muted/50 has-focus-visible:ring-1 has-focus-visible:ring-ring",
                on && "border-foreground bg-muted/50",
              )}
            >
              <Checkbox
                className="mt-px"
                autoFocus={autoFocus && index === 0}
                checked={on}
                disabled={bundle.required}
                onCheckedChange={(next) => toggle(bundle.name, next === true)}
              />
              <span className="min-w-0 space-y-0.5">
                <span className="block font-medium break-words">
                  {bundle.name}
                  {bundle.required
                    ? translateText("bundles.requiredSuffix")
                    : ""}
                  {bundle.builtin ? null : (
                    <span className="ml-1.5 font-normal text-muted-foreground">
                      {translateText("common:labels.custom")}
                    </span>
                  )}
                </span>
                {bundle.description ? (
                  <span className="block text-muted-foreground">
                    {translateBundleDescription(
                      bundle.name,
                      bundle.description,
                    )}
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
  const { t: translateText } = useTranslation([
    "agents",
    "bundles",
    "common",
    "providers",
  ] as const);
  const error = form.formState.errors.name;
  return (
    <div className="space-y-1.5">
      <Label htmlFor="agent-name">{translateText("common:labels.name")}</Label>
      <Input
        id="agent-name"
        autoFocus={autoFocus}
        placeholder={translateText("fields.namePlaceholder")}
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
  const { t: translateText } = useTranslation([
    "agents",
    "bundles",
    "common",
    "providers",
  ] as const);
  const error = form.formState.errors.model;
  // Only once they have loaded can there be none.
  const noModels =
    models !== undefined && !models.some((model) => model.available);
  return (
    <div className="space-y-1.5">
      <Label htmlFor="agent-model">
        {translateText("common:entities.model")}
      </Label>
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
          {error?.message ?? translateText("models.noneAvailable")}
          {noModels ? (
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto px-1"
              onClick={onOpenProviders}
            >
              {translateText("providers:actions.openSettings")}
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
  const { t: translateText } = useTranslation([
    "agents",
    "bundles",
    "common",
    "providers",
  ] as const);
  return (
    <div
      role="group"
      aria-labelledby="agent-bundles"
      aria-describedby="agent-bundles-hint"
      className="space-y-1.5"
    >
      <p id="agent-bundles" className="text-xs leading-none">
        {translateText("bundles:title")}
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
        {translateText("bundles.help")}
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
  const { t: translateText } = useTranslation([
    "agents",
    "bundles",
    "common",
    "providers",
  ] as const);
  const error = form.formState.errors.description;
  const length = form.watch("description").length;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor="agent-description">
          {translateText("editor.tabs.instructions")}
        </Label>
        <span
          className="text-xs tabular-nums text-muted-foreground"
          aria-live="polite"
        >
          {length.toLocaleString(formatLocale())} /{" "}
          {DESCRIPTION_MAX.toLocaleString(formatLocale())}
        </span>
      </div>
      <Textarea
        id="agent-description"
        rows={12}
        autoFocus={autoFocus}
        className="max-h-[50dvh] min-h-48 font-mono leading-relaxed"
        placeholder={translateText("fields.instructionsPlaceholder")}
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
        {error?.message ?? translateText("fields.instructionsHelp")}
      </p>
    </div>
  );
}

/**
 * Which persona card an agent wears.
 *
 * An agent's instructions say what it does; its persona says how it sounds while doing it — the
 * two were never the same field. The host keeps the card (`GET/PUT /api/v1/agents/{id}/persona`,
 * the id is the card's name) and answers `""` for "the project's default", which is a card too,
 * so the field lists it as the first choice rather than as "none".
 */
export function PersonaSelect({
  value,
  onChange,
  invalid,
}: {
  value: string;
  onChange: (next: string) => void;
  invalid?: boolean;
}) {
  const { t: translateText } = useTranslation([
    "agents",
    "chat",
    "common",
  ] as const);
  const { data: cards } = usePersonas();
  const agentId = useWorkspaceStore((s) => s.agentEditor.agentId);
  return (
    <Select
      className="w-full"
      aria-invalid={invalid}
      value={value}
      onValueChange={(next) => {
        onChange(next);
        // An existing agent saves immediately: the card is what the *next* run reads, and a
        // save button on a single dropdown is a save button nobody pressed.
        if (agentId !== null)
          fetch(`/api/v1/agents/${agentId}/persona`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ persona: next }),
          }).catch(() => undefined);
      }}
    >
      <SelectOption value="">
        {translateText("agents:persona.default")}
      </SelectOption>
      {(cards ?? []).map((card) => (
        <SelectOption key={card.id} value={card.id}>
          {card.name}
          <span className="ml-1 text-muted-foreground">
            · {card.description}
          </span>
        </SelectOption>
      ))}
    </Select>
  );
}

/** The persona row in the editor form: label + PersonaSelect wired to react-hook-form. */
export function PersonaField({ form }: { form: Form }) {
  const { t: translateText } = useTranslation(["agents", "common"] as const);
  return (
    <div className="space-y-1.5">
      <Label htmlFor="agent-persona">
        {translateText("agents:persona.label")}
      </Label>
      <PersonaSelect
        value={form.watch("persona")}
        onChange={(next) =>
          form.setValue("persona", next, { shouldDirty: true })
        }
        invalid={Boolean(form.formState.errors.persona)}
      />
    </div>
  );
}
