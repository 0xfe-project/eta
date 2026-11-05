import { Text } from "nsh";

/** An agent's reply. */
export function Markdown(props: { text: string; class?: string }) {
  return <Text class={props.class ?? "text-base leading-[23px] text-foreground"}>{props.text}</Text>;
}
