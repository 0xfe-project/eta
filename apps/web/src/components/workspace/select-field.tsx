import * as React from "react";
import {
  SelectContent,
  SelectGroup as SelectGroupPrimitive,
  SelectItem,
  SelectLabel,
  Select as SelectRoot,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Business values may be empty (clear a work location). Radix reserves "".
const encode = (value: string) => `choice:${value}`;
const decode = (value: string) => value.slice(7);
type SelectProps = Pick<
  React.ComponentProps<typeof SelectRoot>,
  "disabled" | "open" | "onOpenChange" | "onValueChange"
> &
  Pick<
    React.ComponentProps<typeof SelectTrigger>,
    | "id"
    | "aria-label"
    | "aria-labelledby"
    | "aria-describedby"
    | "aria-invalid"
    | "onBlur"
    | "size"
    | "className"
  > & {
    value?: string;
    defaultValue?: string;
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
  children,
  ...props
}: SelectProps) {
  const [localValue, setLocalValue] = React.useState(defaultValue);
  return (
    <SelectRoot
      value={encode(value ?? localValue)}
      disabled={disabled}
      open={open}
      onOpenChange={onOpenChange}
      onValueChange={(next) => {
        // Inside a form Radix mirrors the value into a hidden native select,
        // which reports "" for a value with no option yet (still loading).
        // Only options choose.
        if (!next.startsWith(encode(""))) return;
        const decoded = decode(next);
        setLocalValue(decoded);
        onValueChange?.(decoded);
      }}
    >
      <SelectTrigger
        {...props}
        className={`min-w-0 max-w-full overflow-hidden [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:overflow-hidden [&_[data-slot=select-value]>span]:block [&_[data-slot=select-value]>span]:truncate [&_[data-slot=select-value]>span]:whitespace-nowrap ${className ?? ""}`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        position="popper"
        align="start"
        collisionPadding={8}
        className="w-(--radix-select-trigger-width) max-w-[calc(100vw-1rem)] duration-[60ms] ease-linear motion-reduce:animate-none"
      >
        {children}
      </SelectContent>
    </SelectRoot>
  );
}

function SelectOption({
  value,
  children,
  ...props
}: Omit<React.ComponentProps<typeof SelectItem>, "value"> & {
  value: string | number;
}) {
  return (
    <SelectItem {...props} value={encode(String(value))}>
      <span className="min-w-0 break-words whitespace-normal [overflow-wrap:anywhere]">
        {children}
      </span>
    </SelectItem>
  );
}

function SelectGroup({
  label,
  children,
  ...props
}: React.ComponentProps<typeof SelectGroupPrimitive> & { label: string }) {
  return (
    <SelectGroupPrimitive {...props}>
      <SelectLabel>{label}</SelectLabel>
      {children}
    </SelectGroupPrimitive>
  );
}

export { Select, SelectGroup, SelectOption };
