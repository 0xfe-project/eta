/** The composer's keys: typing, pasting and the bound actions, turned into commands and effects. */
import type { Key } from "ink";
import type { ActionName } from "../../../config/types";
import type { CompletionSources } from "./completion";
import type { ComposerProps } from "./composer";
import type { ComposerCommand, ComposerEffect, KeyContext } from "./keys";
import type { ComposerState } from "./state";
import { useInput, usePaste } from "ink";
import { useLayoutEffect, useRef } from "react";
import { useAction, useConfig } from "../../../extensions/react";
import { matchesBinding } from "../../../ui/key-match";
import { mentionedMembers } from "../model/mentions";
import { menuOf } from "./completion";
import { commandForKey } from "./key-map";
import { applyCommand, canOpenPanel, canSteer, canStop } from "./keys";

interface Snapshot {
  state: ComposerState;
  context: KeyContext;
  sources: CompletionSources;
  props: ComposerProps;
}

function perform(effect: ComposerEffect, props: ComposerProps): void {
  switch (effect.kind) {
    case "send":
      props.onSend({
        text: effect.text,
        pastes: effect.pastes,
        mentions: mentionedMembers(effect.text, props.members),
        mode: effect.mode,
      });
      return;
    case "command":
      props.onCommand(effect.line);
      return;
    case "stop":
      props.onStop();
      return;
    case "panel":
      props.onPanel();
  }
}

/**
 * Binds the composer's keys while `receiving`. `message.newline`, `message.steer`, `reply.stop`
 * and `panel.open` go through `useAction`, so they follow rebinding; a key one of them takes is
 * not also typed.
 */
export function useComposerKeys(snapshot: Snapshot, receiving: boolean): void {
  const { keybindings } = useConfig();
  // Keys can arrive faster than renders; each one works on what the previous one left.
  const latestRef = useRef(snapshot);
  useLayoutEffect(() => {
    latestRef.current = snapshot;
  });

  const run = (command: ComposerCommand) => {
    const now = latestRef.current;
    const result = applyCommand(now.state, command, now.context);
    if (result.state !== now.state) {
      latestRef.current = {
        ...now,
        state: result.state,
        context: { ...now.context, menu: menuOf(result.state, now.sources) },
      };
      now.props.onState(result.state);
    }
    if (result.effect) perform(result.effect, now.props);
  };

  const takenByAction = (input: string, key: Key) => {
    const { state, context } = latestRef.current;
    const bound = (action: ActionName) =>
      keybindings[action].some((binding) =>
        matchesBinding(binding, input, key),
      );
    return (
      bound("message.newline") ||
      (bound("message.steer") && canSteer(state, context)) ||
      (bound("reply.stop") && canStop(state, context)) ||
      (bound("panel.open") && canOpenPanel(state))
    );
  };

  useInput(
    (input, key) => {
      if (takenByAction(input, key)) return;
      const command = commandForKey(input, key);
      if (command) run(command);
    },
    { isActive: receiving },
  );
  usePaste((text) => run({ kind: "paste", text }), { isActive: receiving });

  const { state, context, props } = snapshot;
  useAction("message.newline", () => run({ kind: "newline" }), {
    isActive: props.active,
  });
  useAction("message.steer", () => run({ kind: "steer" }), {
    isActive: props.active && canSteer(state, context),
  });
  useAction("reply.stop", () => run({ kind: "stop" }), {
    isActive: props.active && canStop(state, context),
  });
  useAction("panel.open", () => run({ kind: "panel" }), {
    isActive: props.active && canOpenPanel(state),
  });
}
