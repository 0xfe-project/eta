import { View } from "nsh";

/** A dot or square mark beside a name or a row: a state, an unread count's place. */
export const dotSize = 8;

export function StatusDot(props: {
  color: string;
  size?: number;
  opacity?: number;
}) {
  return (
    <View
      style={{
        width: props.size ?? dotSize,
        height: props.size ?? dotSize,
        backgroundColor: props.color,
        opacity: props.opacity ?? 1,
      }}
    />
  );
}
