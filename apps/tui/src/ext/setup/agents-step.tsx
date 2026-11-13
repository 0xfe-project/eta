import type { AgentView } from "@eta/client-contracts";
import type { Model } from "../kit/models";
import type { PersonaCardSummary } from "./first-run";
import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";
import { useInputActive, useShell, useTheme } from "../../extensions/react";
import { useMessages } from "../../i18n/react";
import { keepTogether } from "../../ui/text-width";
import { inkColor } from "../../ui/theme";
import { useAgents } from "../kit/agents";
import { CheckList } from "../kit/check-list";
import { callErrorText } from "../kit/errors";
import { useTarget } from "../kit/wire-hooks";
import { cardsWithAgents, readAgentsNow } from "./first-run";
import { setupMessages } from "./messages";

/** How long a create waits for the host's current list of agents before it gives up. */
const AGENTS_WAIT_MS = 10_000;

/** What the agents step keeps while the user goes back to the accounts and returns. */
export interface AgentsProgress {
  /** Cards the user unticked; every other card without an agent is ticked. */
  unticked: ReadonlySet<string>;
  /** Cards this setup created an agent for, also before the host's list shows them. */
  created: ReadonlySet<string>;
}

/**
 * One row per persona card, ticked unless unticked or already worn by an agent (those are marked
 * and cannot be ticked). Enter creates the ticked cards' agents in the cards' order on `model`,
 * skipping a card the host's current list shows worn by then, and stops at the first the host
 * refuses, showing why; Enter again goes on from there.
 */
export function AgentsStep({
  model,
  progress,
  onProgress,
  onBack,
  onLeave,
  onDone,
}: {
  model: Model | undefined;
  progress: AgentsProgress;
  /** Takes how to get the next progress from the latest one. */
  onProgress: (update: (latest: AgentsProgress) => AgentsProgress) => void;
  onBack: () => void;
  onLeave: () => void;
  onDone: (created: number) => void;
}) {
  const t = useMessages(setupMessages);
  const theme = useTheme();
  const { wire, locale } = useShell();
  const active = useInputActive();
  const cards = useTarget("personas")?.sections.cards as
    | PersonaCardSummary[]
    | undefined;
  const agents = useAgents();
  const [creating, setCreating] = useState<string>();
  const [error, setError] = useState<string>();
  // Set in the key handler itself: a second key of the same read comes before any re-render.
  const busyRef = useRef(false);

  useInput(
    (_input, key) => {
      if (busyRef.current) return;
      if (key.escape) onLeave();
      else if (key.leftArrow) onBack();
    },
    { isActive: active },
  );

  const muted = inkColor(theme.muted);
  if (cards === undefined || agents === undefined)
    return <Text color={muted}>{t("loading")}</Text>;

  const built = new Set([...cardsWithAgents(agents), ...progress.created]);
  const ticked = new Set(
    cards
      .filter((card) => !built.has(card.id) && !progress.unticked.has(card.id))
      .map((card) => card.id),
  );

  const create = async (wanted: readonly PersonaCardSummary[]) => {
    const created = new Set<string>();
    setError(undefined);
    try {
      for (const card of wanted) {
        // What was drawn may be a copy from before another client gave the card an agent.
        const current = await readAgentsNow(wire, AGENTS_WAIT_MS);
        if (current === undefined) {
          setError(t("agentsUnread"));
          return;
        }
        if (cardsWithAgents(current).has(card.id)) continue;
        setCreating(card.name);
        await wire.call<{ agent: AgentView }>("agents", "create", {
          name: card.name,
          persona: card.id,
          ...(model === undefined ? {} : { model: model.id }),
        });
        created.add(card.id);
      }
      onDone(progress.created.size + created.size);
    } catch (cause) {
      setError(callErrorText(cause, locale));
    } finally {
      onProgress((latest) => ({
        ...latest,
        created: new Set([...latest.created, ...created]),
      }));
      busyRef.current = false;
      setCreating(undefined);
    }
  };

  return (
    <Box flexDirection="column">
      <Text>
        {model === undefined
          ? t("agentsIntroNoModel")
          : t("agentsIntro", {
              model: keepTogether(`${model.providerName} / ${model.name}`),
            })}
      </Text>
      <Box flexDirection="column" marginY={1}>
        <CheckList
          items={cards.map((card) => ({
            key: card.id,
            label: card.name,
            disabled: built.has(card.id),
            ...(built.has(card.id) ? { tag: t("built") } : {}),
          }))}
          checked={ticked}
          onToggle={(key, next) => {
            // The ticks are what is being created while it runs.
            if (busyRef.current) return;
            onProgress((latest) => {
              const unticked = new Set(latest.unticked);
              if (next) unticked.delete(key);
              else unticked.add(key);
              return { ...latest, unticked };
            });
          }}
          onConfirm={(chosen) => {
            if (busyRef.current) return;
            busyRef.current = true;
            void create(cards.filter((card) => chosen.has(card.id)));
          }}
          empty={t("noCards")}
        />
        {creating !== undefined && (
          <Text color={muted}>
            {t("creating", { name: keepTogether(creating) })}
          </Text>
        )}
        {error !== undefined && (
          <Text color={inkColor(theme.error)}>{error}</Text>
        )}
      </Box>
      <Text color={muted}>{t("agentsFooter")}</Text>
    </Box>
  );
}
