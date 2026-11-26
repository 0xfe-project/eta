import { ActionItem, ActionMenu, colors, row } from "../../../components";
import { space } from "../../../components/tokens";
import { effect, signal } from "nsh";

export interface UpdateChannelChoice {
  value: string;
  label: string;
}

/** Both update channels use the same action menu as the rest of Settings. */
export function UpdateChannelMenu(props: {
  label: string;
  value: string;
  choices: readonly UpdateChannelChoice[];
  disabled: boolean;
  onChange: (value: string) => boolean | Promise<boolean>;
}) {
  const c = colors();
  const optimistic = signal<string>();
  const shown = () => optimistic() ?? props.value;
  effect(() => {
    if (optimistic() === props.value) optimistic.set(undefined);
  });
  async function choose(value: string) {
    const previous = optimistic();
    optimistic.set(value);
    try {
      if ((await props.onChange(value)) === false) optimistic.set(previous);
    } catch {
      optimistic.set(previous);
    }
  }
  return (
    <ActionMenu
      label={props.label}
      value={() =>
        props.choices.find((choice) => choice.value === shown())?.label ??
        shown()
      }
      disabled={props.disabled}
      triggerStyle={{
        ...row,
        width: "100%",
        paddingHorizontal: space[12],
        borderWidth: 1,
        borderColor: c().strong,
      }}
    >
      <Each of={props.choices} key={(choice) => choice.value}>
        {(choice) => (
          <ActionItem
            label={choice().label}
            checked={() => choice().value === shown()}
            onSelect={() => void choose(choice().value)}
          />
        )}
      </Each>
    </ActionMenu>
  );
}
