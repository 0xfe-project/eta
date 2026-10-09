import { CaretDownIcon, CaretUpIcon, CheckIcon } from "@phosphor-icons/react";
import { cn } from "cn";
import { Select as Primitive } from "radix-ui";
import * as React from "react";

// Encode every value: Radix reserves "", while business forms allow clearing.
const encode = (value: string) => `choice:${value}`;
const decode = (value: string) => value.slice(7);
type SelectProps = Pick<
  React.ComponentProps<typeof Primitive.Root>,
  "disabled" | "open" | "onOpenChange" | "onValueChange"
> &
  Pick<
    React.ComponentProps<typeof Primitive.Trigger>,
    | "id"
    | "aria-label"
    | "aria-labelledby"
    | "aria-describedby"
    | "aria-invalid"
    | "onBlur"
  > & {
    value?: string;
    defaultValue?: string;
    className?: string;
    size?: "sm" | "default";
    children: React.ReactNode;
  };

function Select({
  value,
  defaultValue = "",
  onValueChange,
  disabled,
  open,
  onOpenChange,
  className,
  size = "default",
  children,
  ...props
}: SelectProps) {
  const [localValue, setLocalValue] = React.useState(defaultValue);
  return (
    <Primitive.Root
      value={encode(value ?? localValue)}
      disabled={disabled}
      open={open}
      onOpenChange={onOpenChange}
      onValueChange={(next) => {
        const decoded = decode(next);
        setLocalValue(decoded);
        onValueChange?.(decoded);
      }}
    >
      <Primitive.Trigger
        {...props}
        data-slot="select-trigger"
        data-size={size}
        className={cn(
          "flex h-8 w-fit min-w-0 max-w-full items-center justify-between gap-2 rounded-none border border-input bg-transparent px-2.5 py-1 text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive data-[size=sm]:h-7 dark:bg-input/30 [&_[data-slot=select-value]]:truncate",
          className,
        )}
      >
        <Primitive.Value data-slot="select-value" />
        <Primitive.Icon asChild>
          <CaretDownIcon className="size-4 shrink-0 text-muted-foreground" />
        </Primitive.Icon>
      </Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          data-slot="select-content"
          position="popper"
          sideOffset={4}
          collisionPadding={8}
          className="z-50 max-h-(--radix-select-content-available-height) w-(--radix-select-trigger-width) min-w-32 max-w-[calc(100vw-1rem)] overflow-hidden rounded-none bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10"
        >
          <Primitive.ScrollUpButton className="flex justify-center py-1">
            <CaretUpIcon className="size-4" />
          </Primitive.ScrollUpButton>
          <Primitive.Viewport className="p-1">{children}</Primitive.Viewport>
          <Primitive.ScrollDownButton className="flex justify-center py-1">
            <CaretDownIcon className="size-4" />
          </Primitive.ScrollDownButton>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
function SelectOption({
  value,
  children,
  className,
  ...props
}: Omit<React.ComponentProps<typeof Primitive.Item>, "value"> & {
  value: string | number;
}) {
  return (
    <Primitive.Item
      {...props}
      value={encode(String(value))}
      data-slot="select-item"
      className={cn(
        "relative flex cursor-default items-center rounded-none py-2 pr-8 pl-2 text-xs outline-none select-none focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
        className,
      )}
    >
      <Primitive.ItemText>
        <span className="break-words whitespace-normal [overflow-wrap:anywhere]">
          {children}
        </span>
      </Primitive.ItemText>
      <Primitive.ItemIndicator className="absolute right-2">
        <CheckIcon className="size-4" />
      </Primitive.ItemIndicator>
    </Primitive.Item>
  );
}
function SelectGroup({
  label,
  children,
  ...props
}: React.ComponentProps<typeof Primitive.Group> & { label: string }) {
  return (
    <Primitive.Group {...props}>
      <Primitive.Label className="px-2 py-2 text-xs text-muted-foreground">
        {label}
      </Primitive.Label>
      {children}
    </Primitive.Group>
  );
}
export { Select, SelectGroup, SelectOption };
