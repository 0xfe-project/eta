import type { AgentResults } from "@eta/client-contracts";
import type { Easing } from "nsh";
import {
  AnimatedValue,
  cleanup,
  effect,
  reduceMotion,
  signal,
  untracked,
  View,
} from "nsh";
import { Button, colors, focusRing, Label, row } from "../../../components";
import { AgentFace } from "../../../components/agent-face";
import { motion as appMotion } from "../../../components/motion";
import {
  avatar,
  control,
  icon,
  opacity,
  space,
} from "../../../components/tokens";
import { localizedText } from "../../../i18n";
import { useHost } from "../../../services/host";
import { problemText } from "../../../services/problem-text";
import { EditorRow } from "./editor-row";

/** The avatar row's picker beside its label. */
const avatarFieldWidth = 300;

/** As many faces as the host keeps. */
const HISTORY = 8;
/** Faces the large avatar passes over before it lands. */
const FLICKS = 3;
const settleEasing: Easing = [0.2, 0, 0, 1];

/** The one source of faces: passing and landed alike. */
const drawSeed = () => crypto.randomUUID().slice(0, 8);

/** The seeds worn with `seed` worn now: first, once, the oldest past the last few gone. */
const wearing = (seeds: readonly string[], seed: string): string[] =>
  [seed, ...seeds.filter((other) => other !== seed)].slice(0, HISTORY);

/**
 * An agent's face and the faces it wore last, as the editor changes them. A draw passes over a few
 * faces and lands on one; the face it lands on, or one taken back from the recent ones, is worn at
 * once and saved behind it (`agents.update` with `avatarSeed`), and a save that fails puts the face
 * that was there back. Taking one back draws nothing new. With reduced motion a draw lands at once.
 */
export function createAvatarDraw(agentId: string) {
  const host = useHost();
  const saved = () => host.agent(agentId)?.avatarSeed ?? agentId;
  // An agent that never drew a face wears its id.
  const history = () => {
    const seeds = host.agent(agentId)?.avatarSeeds ?? [];
    return seeds.length > 0 ? seeds : [saved()];
  };
  /** The face being saved; null once the host's agent wears it, or could not take it. */
  const pending = signal<string | null>(null);
  /** The last face the host said it saved. */
  const confirmed = signal<string | null>(null);
  /** The face passing now, null outside the passing frames. */
  const passing = signal<string | null>(null);
  /** From the click until the landed face has settled; a draw meanwhile does nothing. */
  const rolling = signal(false);
  const failure = signal("");
  const scale = new AnimatedValue(1);
  const turn = new AnimatedValue(0);
  const opacity = new AnimatedValue(1);
  const timers: ReturnType<typeof setTimeout>[] = [];
  cleanup(() => timers.forEach(clearTimeout));

  const worn = () => pending() ?? saved();
  const seeds = () => {
    const next = pending();
    return next === null ? history() : wearing(history(), next);
  };

  // Saved, and the host's agent has it: the host's answer is the face from then on.
  effect(() => {
    const next = pending();
    if (next !== null && confirmed() === next && saved() === next)
      pending.set(null);
  });

  function enter(motion: "flick" | "settle" | "fade") {
    if (reduceMotion()) return;
    if (motion === "fade") {
      opacity.set(0);
      void opacity.timing(1, {
        duration: appMotion.avatarFade,
        easing: "linear",
      });
      return;
    }
    scale.set(motion === "flick" ? 0.94 : 0.9);
    void scale.timing(1, {
      duration:
        motion === "flick" ? appMotion.avatarFlick : appMotion.avatarSettle,
      easing: motion === "flick" ? "linear" : settleEasing,
    });
    if (motion === "settle") {
      turn.set(-6);
      void turn.timing(0, {
        duration: appMotion.avatarSettle,
        easing: settleEasing,
      });
    }
  }

  function wear(next: string, motion: "settle" | "fade") {
    if (next === worn()) return;
    failure.set("");
    pending.set(next);
    enter(motion);
    host
      .call<AgentResults["update"]>("agents", "update", {
        agentId,
        avatarSeed: next,
      })
      .then(
        () => confirmed.set(next),
        (problem: unknown) => {
          // A later face has taken its place: that one's answer settles it.
          if (untracked(pending) !== next) return;
          pending.set(null);
          failure.set(problemText(problem));
        },
      );
  }

  function flick() {
    passing.set(drawSeed());
    enter("flick");
  }

  function roll() {
    if (rolling()) return;
    if (reduceMotion()) {
      wear(drawSeed(), "settle");
      return;
    }
    rolling.set(true);
    const at = (ms: number, step: () => void) =>
      timers.push(setTimeout(step, ms));
    flick();
    for (let frame = 1; frame < FLICKS; frame++)
      at(frame * appMotion.avatarFlick, flick);
    at(FLICKS * appMotion.avatarFlick, () => {
      passing.set(null);
      wear(drawSeed(), "settle");
    });
    at(FLICKS * appMotion.avatarFlick + appMotion.avatarSettle, () => {
      timers.length = 0;
      rolling.set(false);
    });
  }

  return {
    agentId,
    /** The face worn: the one being saved, else the host's. */
    worn,
    /** The face the large avatar shows: a passing one while a draw rolls. */
    shown: () => passing() ?? worn(),
    seeds,
    failure,
    scale,
    turn,
    opacity,
    roll,
    wear,
  };
}

export type AvatarDraw = ReturnType<typeof createAvatarDraw>;

/**
 * The General tab's avatar row: the large face, the button that draws another, and the faces it
 * wore last, the one worn marked; pressing one wears it again.
 */
export function AvatarRow(props: {
  draw: AvatarDraw;
  stacked: boolean;
  phone: boolean;
}) {
  const c = colors();
  const draw = props.draw;
  const drawLabel = localizedText("Draw another face", "重新抽一张");
  return (
    <EditorRow
      label={localizedText("Avatar", "头像")}
      stack={props.stacked}
      phone={props.phone}
      width={avatarFieldWidth}
      hint={
        <If when={draw.failure()}>
          <Label variant="small" tone="red">
            {localizedText(
              `The face was not saved: ${draw.failure()}`,
              `头像未保存：${draw.failure()}`,
            )}
          </Label>
        </If>
      }
    >
      <View style={{ ...row, gap: space[8] }}>
        <View
          testID={`avatar:${draw.shown()}`}
          style={{
            scale: draw.scale,
            rotate: draw.turn,
            opacity: draw.opacity,
            flexShrink: 0,
          }}
        >
          <AgentFace
            id={draw.agentId}
            seed={draw.shown()}
            size={props.phone ? avatar.xl : avatar.lg}
          />
        </View>
        <Button
          label={drawLabel}
          icon="dice"
          iconOnly
          iconSize={icon.md}
          tone="ghost"
          size={props.phone ? control.lg : control.sm}
          onPress={draw.roll}
        />
        <View
          accessibilityLabel={localizedText("Recent faces", "最近的头像")}
          style={{
            ...row,
            flex: 1,
            minWidth: 0,
            flexWrap: "wrap",
            gap: space[4],
          }}
        >
          <Each of={draw.seeds()} key={(face) => face}>
            {(face, index) => (
              <View
                role="button"
                testID={`recent:${index()}:${face()}`}
                accessibilityLabel={
                  face() === draw.worn()
                    ? localizedText("Current face", "当前头像")
                    : localizedText("Wear this face again", "换回这张头像")
                }
                accessibilityState={{ selected: face() === draw.worn() }}
                onPress={() => draw.wear(face(), "fade")}
                hoverStyle={{ opacity: 1 }}
                focusVisibleStyle={focusRing(c())}
                style={{
                  width: space[24],
                  height: space[24],
                  alignItems: "center",
                  justifyContent: "center",
                  borderWidth: 1,
                  borderColor: face() === draw.worn() ? c().ink : "transparent",
                  opacity: face() === draw.worn() ? 1 : opacity.muted,
                  cursor: "pointer",
                }}
              >
                <AgentFace id={draw.agentId} seed={face()} size={avatar.sm} />
              </View>
            )}
          </Each>
        </View>
      </View>
    </EditorRow>
  );
}
