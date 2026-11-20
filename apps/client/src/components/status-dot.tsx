import { View } from "nsh";

export function StatusDot(props: {
  color: string;
  size?: number;
  opacity?: number;
}) {
  return (
    <View
      style={{
        width: props.size ?? 6,
        height: props.size ?? 6,
        backgroundColor: props.color,
        opacity: props.opacity ?? 1,
      }}
    />
  );
}
