import type { AgentView } from "@eta/client-contracts";
import type { ReactNode } from "react";
import { DiceFiveIcon } from "@phosphor-icons/react/DiceFive";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useUpdateAgent } from "@/queries/agents";
import { AgentAvatar } from "./agent-identity";

/** As many faces as the host keeps. */
const HISTORY = 8;

/** The seeds worn with `seed` worn now: first, once, the oldest past the last few gone. */
const wearing = (seeds: readonly string[], seed: string): string[] =>
  [seed, ...seeds.filter((other) => other !== seed)].slice(0, HISTORY);

/**
 * The agent's large avatar with a button that draws another face and the faces it wore last, to
 * go back to. The new face shows at once and is saved behind it; a save that fails puts the face
 * that was there back.
 */
export function AvatarDraw({
  agent,
  children,
}: {
  agent: AgentView;
  /** What sits beside the avatar, above the faces: the agent's name. */
  children: ReactNode;
}) {
  const { t: translateText } = useTranslation("agents");
  const updateAgent = useUpdateAgent();
  // The face being saved; null once the host has it, or could not take it.
  const [pending, setPending] = useState<string | null>(null);
  const saved = agent.avatarSeed ?? agent.id;
  // An agent that never drew a face wears its id.
  const history = agent.avatarSeeds.length > 0 ? agent.avatarSeeds : [saved];
  const seed = pending ?? saved;
  const seeds = pending === null ? history : wearing(history, pending);

  const wear = (next: string) => {
    if (next === seed) return;
    setPending(next);
    updateAgent.mutate(
      { agentId: agent.id, avatarSeed: next },
      {
        // A later draw has taken its place: that one's answer settles the face.
        onSettled: () =>
          setPending((current) => (current === next ? null : current)),
        onError: (error) => toast.error(error.message),
      },
    );
  };

  return (
    <div className="flex min-w-0 items-center gap-3">
      <AgentAvatar
        agent={{ id: agent.id, avatarSeed: seed }}
        className="size-12"
      />
      <div className="min-w-0 space-y-1">
        {children}
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={translateText("editor.avatar.draw")}
            title={translateText("editor.avatar.draw")}
            onClick={() => wear(crypto.randomUUID().slice(0, 8))}
          >
            <DiceFiveIcon aria-hidden="true" />
          </Button>
          <div
            role="group"
            aria-label={translateText("editor.avatar.recent")}
            className="flex items-center gap-1"
          >
            {seeds.map((face) => (
              <button
                key={face}
                type="button"
                aria-label={translateText(
                  face === seed
                    ? "editor.avatar.current"
                    : "editor.avatar.wear",
                )}
                aria-pressed={face === seed}
                onClick={() => wear(face)}
                className={cn(
                  "size-6 shrink-0 outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  face === seed
                    ? "border border-foreground"
                    : "opacity-60 hover:opacity-100",
                )}
              >
                <AgentAvatar
                  agent={{ id: agent.id, avatarSeed: face }}
                  className="size-6"
                />
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
