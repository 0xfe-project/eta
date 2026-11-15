import type { Model } from "@/queries/providers";
import { CaretDownIcon } from "@phosphor-icons/react";
import { cn } from "cn";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { selectTriggerClassName } from "@/components/ui/select";
import { modelGroups } from "@/queries/providers";

// cmdk trims item values and wants them unique; the empty choice ("no model of its own") is not
// a model id, so every item gets a prefix.
const DEFAULT_ITEM = "default";
const itemValue = (modelId: string) => `model:${modelId}`;

/**
 * Models grouped by service, searchable by id, name and service; unusable ones stay visible but
 * disabled. A popover with a search box rather than a plain select: a gateway such as OpenCode Zen
 * lists a hundred models or more.
 */
export function ModelSelect({
  value,
  models,
  invalid,
  defaultLabel,
  onValueChange,
  disabled,
  className,
  ...props
}: Pick<
  React.ComponentProps<"button">,
  "id" | "aria-label" | "aria-labelledby" | "aria-describedby" | "className"
> & {
  value: string;
  /**
   * Undefined while they load. Null when they cannot be listed (the machine is out of reach): the
   * chosen one then shows as it is, since there is no list to say it is gone.
   */
  models: Model[] | null | undefined;
  invalid?: boolean;
  /** Offers "no model of its own" (the empty value) under this name, instead of asking to pick. */
  defaultLabel?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
}) {
  const { t: translateText } = useTranslation([
    "agents",
    "common",
    "providers",
  ] as const);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const loading = models === undefined;
  const chosen = (models ?? []).find((model) => model.id === value);
  const unavailableSuffix = translateText("common:status.unavailableSuffix");
  const modelLabel = (model: Model) =>
    model.available ? model.name : `${model.name}${unavailableSuffix}`;
  // The chosen model when the list no longer has it: shown, never offered.
  const missingLabel =
    value && !chosen
      ? loading
        ? translateText("models.loading")
        : models === null
          ? value
          : translateText("models.deletedOption", { modelName: value })
      : undefined;
  const placeholder =
    defaultLabel ??
    (loading
      ? translateText("models.loading")
      : translateText("models.select"));
  const triggerLabel = chosen
    ? modelLabel(chosen)
    : (missingLabel ?? placeholder);

  const query = search.trim().toLowerCase();
  const matches = (...texts: string[]) =>
    query === "" || texts.some((text) => text.toLowerCase().includes(query));
  const groups = modelGroups(models ?? [])
    .map((group) => ({
      ...group,
      models: group.models.filter((model) =>
        matches(model.id, model.name, model.providerName),
      ),
    }))
    .filter((group) => group.models.length > 0);
  const showDefault = defaultLabel !== undefined && matches(defaultLabel);
  const showMissing =
    missingLabel !== undefined && matches(value, missingLabel);

  // Open on the current choice, scrolled into view, like a native select.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      listRef.current
        ?.querySelector('[data-selected="true"]')
        ?.scrollIntoView?.({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const choose = (next: string) => {
    onValueChange?.(next);
    setOpen(false);
  };

  return (
    <Popover
      // Modal, so the list scrolls inside a dialog whose scroll lock would otherwise eat the wheel.
      modal
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-invalid={invalid}
          disabled={loading || disabled}
          data-size="default"
          data-placeholder={
            !chosen && missingLabel === undefined && defaultLabel === undefined
              ? ""
              : undefined
          }
          className={cn(
            selectTriggerClassName,
            "w-full min-w-0 max-w-full overflow-hidden",
            className,
          )}
          {...props}
        >
          <span className="min-w-0 truncate">{triggerLabel}</span>
          <CaretDownIcon className="pointer-events-none size-4 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={8}
        className="w-(--radix-popover-trigger-width) min-w-64 max-w-[calc(100vw-1rem)] gap-0 p-0 duration-[60ms] ease-linear motion-reduce:animate-none"
      >
        <Command
          shouldFilter={false}
          defaultValue={value === "" ? DEFAULT_ITEM : itemValue(value)}
        >
          <CommandInput
            value={search}
            onValueChange={(next) => {
              setSearch(next);
              // The list was scrolled to the current choice; the matches start at the top.
              listRef.current?.scrollTo?.({ top: 0 });
            }}
            placeholder={translateText("models.search")}
            aria-label={translateText("models.search")}
          />
          <CommandList
            ref={listRef}
            className="max-h-[min(18rem,calc(var(--radix-popover-content-available-height)-2.5rem))]"
          >
            <CommandEmpty>{translateText("models.noMatch")}</CommandEmpty>
            {showDefault || showMissing ? (
              <CommandGroup>
                {showDefault ? (
                  <CommandItem
                    value={DEFAULT_ITEM}
                    data-checked={value === ""}
                    onSelect={() => choose("")}
                  >
                    {defaultLabel}
                  </CommandItem>
                ) : null}
                {showMissing ? (
                  <CommandItem value={itemValue(value)} data-checked disabled>
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      {missingLabel}
                    </span>
                  </CommandItem>
                ) : null}
              </CommandGroup>
            ) : null}
            {groups.map(({ provider, label, models }) => (
              <CommandGroup key={`${provider}:${label}`} heading={label}>
                {models.map((model) => (
                  <CommandItem
                    key={model.id}
                    value={itemValue(model.id)}
                    data-checked={model.id === value}
                    disabled={!model.available && model.id !== value}
                    onSelect={() => choose(model.id)}
                  >
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      {modelLabel(model)}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
