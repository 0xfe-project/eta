import type { PanEvent, Point, PressEvent, ViewRef } from "nsh";
import { signal } from "nsh";

export function taskDropZones<T extends string>(
  drop: (source: string, target: T) => void,
) {
  const targets = new Map<T, ViewRef>();
  const active = signal("");
  const gesture = (id: string) => {
    let origin: Point | undefined;
    return {
      onPressDown(event: PressEvent) {
        origin = event.pagePosition;
      },
      onPanStart() {
        active.set(id);
      },
      async onPanEnd(event: PanEvent) {
        const start = origin;
        origin = undefined;
        active.set("");
        if (
          !start ||
          event.cancelled ||
          Math.hypot(event.translation.x, event.translation.y) < 5
        )
          return;
        const x = start.x + event.translation.x;
        const y = start.y + event.translation.y;
        const measured = await Promise.all(
          [...targets].map(async ([key, view]) => ({
            key,
            box: await view.measure(),
          })),
        );
        const target = measured.find(
          ({ box }) =>
            box &&
            x >= box.pagePosition.x &&
            x < box.pagePosition.x + box.bounds.size.width &&
            y >= box.pagePosition.y &&
            y < box.pagePosition.y + box.bounds.size.height,
        );
        if (target) drop(id, target.key);
      },
    };
  };
  return {
    active,
    gesture,
    register: (key: T, view: ViewRef) => targets.set(key, view),
  };
}
