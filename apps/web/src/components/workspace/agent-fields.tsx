import type { AgentRuntimeInfo } from "@eta/client-contracts";
import type { UseFormReturn } from "react-hook-form";
import type { AgentForm } from "./agent-form";
import type { Model } from "@/queries/providers";
import { useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatLocale } from "@/lib/i18n";
import { THINKING_LEVELS } from "@/lib/thinking";
import { useBundles } from "@/queries/bundles";
import { usePersonas } from "@/queries/personas";
import { useMachines } from "@/queries/projects";
import { modelGroups } from "@/queries/providers";
import { DESCRIPTION_MAX } from "./agent-form";
import { Select, SelectGroup, SelectOption } from "./select-field";

type Form = UseFormReturn<AgentForm>;

/** Models grouped by service; unusable ones stay visible but disabled. */
export function ModelSelect({
  value,
  models,
  invalid,
  defaultLabel,
  ...props
}: Omit<React.ComponentProps<typeof Select>, "children"> & {
  value: string;
  /**
   * Undefined while they load. Null when they cannot be listed (the machine is out of reach): the
   * chosen one then shows as it is, since there is no list to say it is gone.
   */
  models: Model[] | null | undefined;
  invalid?: boolean;
  /** Offers "no model of its own" (the empty value) under this name, instead of asking to pick. */
  defaultLabel?: string;
}) {
  const { t: translateText } = useTranslation([
    "agents",
    "common",
    "providers",
  ] as const);
  const loading = models === undefined;
  const groups = modelGroups(models ?? []);
  const known = (models ?? []).some((model) => model.id === value);
  return (
    <Select
      className="w-full"
      aria-invalid={invalid}
      value={value}
      {...props}
      disabled={loading || props.disabled}
    >
      <SelectOption value="" disabled={defaultLabel === undefined}>
        {defaultLabel ??
          (loading
            ? translateText("models.loading")
            : translateText("models.select"))}
      </SelectOption>
      {value && !known ? (
        <SelectOption value={value} disabled>
          {loading
            ? translateText("models.loading")
            : models === null
              ? value
              : translateText("models.deletedOption", { modelName: value })}
        </SelectOption>
      ) : null}
      {groups.map(({ provider, label, models }) => (
        <SelectGroup key={provider} label={label}>
          {models.map((model) => (
            <SelectOption
              key={model.id}
              value={model.id}
              disabled={!model.available && model.id !== value}
            >
              {model.name}
              {model.available
                ? ""
                : translateText("common:status.unavailableSuffix")}
            </SelectOption>
          ))}
        </SelectGroup>
      ))}
    </Select>
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

/**
 * The machine the agent runs on: the project's, or one it is pinned to. Only offered when there is
 * more than one machine to choose from. Another machine has other runtimes, so an external
 * runtime's model is cleared.
 */
export function MachineField({ form }: { form: Form }) {
  const { t: translateText } = useTranslation(["agents", "machines"] as const);
  const { machines } = useMachines();
  const value = useWatch({ control: form.control, name: "machineId" });
  const choices = machines.filter(
    (machine) =>
      (machine.kind === "primary" || machine.kind === "daemon") &&
      machine.status !== "pending" &&
      machine.status !== "revoked",
  );
  if (choices.length < 2 && value === "") return null;
  return (
    <div className="space-y-1.5">
      <Label htmlFor="agent-machine">
        {translateText("agents:machine.label")}
      </Label>
      <Select
        id="agent-machine"
        className="w-full"
        value={value}
        onValueChange={(next) => {
          form.setValue("machineId", next, { shouldDirty: true });
          if (form.getValues("runtime") !== "eta") {
            form.setValue("model", "", { shouldDirty: true });
            form.clearErrors("model");
          }
        }}
      >
        <SelectOption value="">
          {translateText("agents:machine.followProject")}
        </SelectOption>
        {choices.map((machine) => (
          <SelectOption key={machine.id} value={machine.id}>
            {machine.name}
            {machine.status === "online"
              ? ""
              : translateText("agents:machine.offlineSuffix")}
          </SelectOption>
        ))}
      </Select>
    </div>
  );
}

/**
 * What answers for the agent: eta's own loop, or an agent runtime on the machine (Claude Code,
 * Codex, ...). Another runtime has other models, so a change clears the model.
 *
 * The agent's own runtime stays in the list when the machine's list does not have it, so the
 * trigger never goes blank: as still being looked for while the machine is asked, and as
 * unavailable when it has no such runtime or could not be asked.
 */
export function RuntimeField({
  form,
  runtimes,
}: {
  form: Form;
  /** Undefined while the host looks; null when the machine could not be asked. */
  runtimes: AgentRuntimeInfo[] | null | undefined;
}) {
  const { t: translateText } = useTranslation(["agents", "common"] as const);
  const value = useWatch({ control: form.control, name: "runtime" });
  const listed =
    value === "eta" || (runtimes ?? []).some((runtime) => runtime.id === value);
  return (
    <div className="space-y-1.5">
      <Label htmlFor="agent-runtime">
        {translateText("agents:runtime.label")}
      </Label>
      <Select
        id="agent-runtime"
        className="w-full"
        value={value}
        aria-describedby={runtimes === null ? "agent-runtime-hint" : undefined}
        onValueChange={(next) => {
          form.setValue("runtime", next as AgentForm["runtime"], {
            shouldDirty: true,
          });
          form.setValue("model", "", { shouldDirty: true });
          form.clearErrors("model");
        }}
      >
        <SelectOption value="eta">
          {translateText("agents:runtime.eta")}
        </SelectOption>
        {runtimes === undefined ? (
          <SelectOption value={listed ? "" : value} disabled>
            {translateText("agents:runtime.loading")}
          </SelectOption>
        ) : (
          <>
            {listed ? null : (
              <SelectOption value={value} disabled>
                {value}
                {translateText("agents:runtime.status.error")}
              </SelectOption>
            )}
            {(runtimes ?? []).map((runtime) => (
              <SelectOption
                key={runtime.id}
                value={runtime.id}
                disabled={
                  runtime.status !== "available" && runtime.id !== value
                }
              >
                {runtime.label}
                {runtime.status === "available"
                  ? ""
                  : translateText(`agents:runtime.status.${runtime.status}`)}
              </SelectOption>
            ))}
          </>
        )}
      </Select>
      {runtimes === null ? (
        <p id="agent-runtime-hint" className="text-xs text-muted-foreground">
          {translateText("agents:runtime.unreachable")}
        </p>
      ) : null}
    </div>
  );
}

export function ModelField({
  form,
  models,
  onOpenProviders,
  external = false,
}: {
  form: Form;
  /** Undefined while they load; null when they cannot be listed. */
  models: Model[] | null | undefined;
  onOpenProviders: () => void;
  /** An external runtime's models: none chosen is the runtime's own default, not a gap. */
  external?: boolean;
}) {
  const { t: translateText } = useTranslation([
    "agents",
    "common",
    "providers",
  ] as const);
  const error = form.formState.errors.model;
  // useWatch, not form.watch: the React Compiler memoises these components on their props, and
  // `form` is the same object every render. A read the compiler cannot see never invalidates that
  // memo, so the component kept its old render and the trigger kept its old label.
  const chosenModel = useWatch({ control: form.control, name: "model" });
  // Only once they have loaded can there be none.
  const noModels =
    !external && models?.some((model) => model.available) === false;
  return (
    <div className="space-y-1.5">
      <Label htmlFor="agent-model">
        {translateText("common:entities.model")}
      </Label>
      <ModelSelect
        id="agent-model"
        value={chosenModel}
        models={models}
        invalid={Boolean(error)}
        {...(external
          ? { defaultLabel: translateText("agents:runtime.defaultModel") }
          : {})}
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

/**
 * How hard the agent thinks before it answers. The first choice, "the model's own", leaves the
 * level unset, which is a level too: it is what a model does when nobody asked for more or less.
 */
export function ThinkingField({ form }: { form: Form }) {
  const { t: translateText } = useTranslation(["agents", "common"] as const);
  const value = useWatch({ control: form.control, name: "thinkingLevel" });
  return (
    <div className="space-y-1.5">
      <Label htmlFor="agent-thinking">
        {translateText("agents:thinking.label")}
      </Label>
      <Select
        id="agent-thinking"
        className="w-full"
        value={value}
        onValueChange={(value) =>
          form.setValue("thinkingLevel", value, { shouldDirty: true })
        }
      >
        <SelectOption value="">
          {translateText("agents:thinking.default")}
        </SelectOption>
        {value !== "" &&
        !(THINKING_LEVELS as readonly string[]).includes(value) ? (
          <SelectOption value={value}>{value}</SelectOption>
        ) : null}
        {THINKING_LEVELS.map((level) => (
          <SelectOption key={level} value={level}>
            {level}
          </SelectOption>
        ))}
      </Select>
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
    "common",
    "providers",
  ] as const);
  const error = form.formState.errors.description;
  const description = useWatch({ control: form.control, name: "description" });
  const length = (description ?? "").length;
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
 * two were never the same field. The cards are the host's (`personas` target, the id is the card's
 * name), and `""` is "the project's default", which is a card too, so the field lists it as the
 * first choice rather than as "none". It is saved with the rest of the form.
 */
function PersonaSelect({
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
  const cards = usePersonas();
  return (
    <Select
      id="agent-persona"
      className="w-full"
      aria-invalid={invalid}
      value={value}
      onValueChange={onChange}
    >
      <SelectOption value="">
        {translateText("agents:persona.default")}
      </SelectOption>
      {cards.map((card) => (
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
  const persona = useWatch({ control: form.control, name: "persona" });
  return (
    <div className="space-y-1.5">
      <Label htmlFor="agent-persona">
        {translateText("agents:persona.label")}
      </Label>
      <PersonaSelect
        value={persona}
        onChange={(next) =>
          form.setValue("persona", next, { shouldDirty: true })
        }
        invalid={Boolean(form.formState.errors.persona)}
      />
    </div>
  );
}

/**
 * Which bundles the agent loads. The names it already holds stay listed even when the host no
 * longer has them, so they can be unchecked.
 */
export function BundlesField({ form }: { form: Form }) {
  const { t: translateText } = useTranslation(["bundles", "common"] as const);
  const { bundles } = useBundles();
  const chosen = useWatch({ control: form.control, name: "bundles" }) ?? [];
  const gone = chosen.filter(
    (name) => !bundles.some((bundle) => bundle.name === name),
  );
  const toggle = (name: string, on: boolean) =>
    form.setValue(
      "bundles",
      on ? [...chosen, name] : chosen.filter((item) => item !== name),
      { shouldDirty: true },
    );
  return (
    <div role="group" aria-labelledby="agent-bundles" className="space-y-1.5">
      <p id="agent-bundles" className="text-xs text-muted-foreground">
        {translateText("picker.help")}
      </p>
      {bundles.length + gone.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {translateText("picker.empty")}
        </p>
      ) : (
        <ul className="divide-y border">
          {bundles.map((bundle) => (
            <li key={bundle.name}>
              <Label className="items-start gap-3 p-2.5 leading-snug">
                <Checkbox
                  className="mt-px"
                  checked={chosen.includes(bundle.name)}
                  disabled={
                    bundle.problem !== null && !chosen.includes(bundle.name)
                  }
                  onCheckedChange={(on) => toggle(bundle.name, on === true)}
                />
                <span className="min-w-0 space-y-0.5">
                  <span className="block font-medium">{bundle.name}</span>
                  <span className="block text-muted-foreground">
                    {bundle.problem ?? bundle.description}
                  </span>
                  {bundle.problem === null &&
                  bundle.fields.length > 0 &&
                  !bundle.configured ? (
                    <span className="block text-xs text-muted-foreground">
                      {translateText("picker.notConfigured")}
                    </span>
                  ) : null}
                </span>
              </Label>
            </li>
          ))}
          {gone.map((name) => (
            <li key={name}>
              <Label className="items-start gap-3 p-2.5 leading-snug">
                <Checkbox
                  className="mt-px"
                  checked
                  onCheckedChange={() => toggle(name, false)}
                />
                <span className="min-w-0 space-y-0.5">
                  <span className="block font-medium">{name}</span>
                  <span className="block text-muted-foreground">
                    {translateText("picker.gone")}
                  </span>
                </span>
              </Label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
