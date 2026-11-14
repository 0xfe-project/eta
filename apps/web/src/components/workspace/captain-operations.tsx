import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useCaptain, useCaptainActions } from "@/queries/captain";
import { useModels } from "@/queries/providers";
import { ModelSelect } from "./model-select";
import { Section } from "./panel-section";

/**
 * What answers for Captain. Captain is not edited the way the other agents are (its changes go
 * through the captain target), so this is the one place to choose its model; it was in the drawer,
 * and went with it. With none chosen, Captain has no model to run on and says so when asked.
 *
 * The parent keys it by the saved model, so a save from elsewhere starts it over from that.
 */
export function CaptainModel() {
  const { t: translateText } = useTranslation("captain");
  const captain = useCaptain();
  const actions = useCaptainActions();
  const { data: models } = useModels();
  const saved = captain.identity?.model ?? "";
  const [model, setModel] = useState(saved);
  if (captain.identity === null) return null;
  const save = () => {
    void actions.setModel
      .mutateAsync({ model })
      .then(() => toast.success(translateText("model.saved")))
      .catch((error: Error) => toast.error(error.message));
  };
  return (
    <Section title={translateText("model.label")}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <ModelSelect
            id="captain-model"
            value={model}
            models={models}
            aria-label={translateText("model.label")}
            aria-describedby="captain-model-help"
            onValueChange={setModel}
          />
        </div>
        <Button
          type="button"
          size="sm"
          disabled={
            model === "" || model === saved || actions.setModel.isPending
          }
          onClick={save}
        >
          {translateText("model.save")}
        </Button>
      </div>
      <p id="captain-model-help" className="mt-1 text-xs text-muted-foreground">
        {translateText("model.help")}
      </p>
    </Section>
  );
}

/**
 * Operations: the two things about Captain's work that a chat cannot carry — an approval it cannot give
 * itself, and what it handed out recently. There is no list of Captain's alerts: everything one said
 * (a task that stopped retrying, a question waiting in the Inbox, an acceptance recommendation) is
 * already on the board, in the Inbox or on the task, and a second copy only had to be marked read.
 *
 * They used to be the second tab of a drawer that held the whole of Captain. The drawer is gone
 * (the conversation is the chat, the head of the sidebar is its card), and this is the half of it
 * that had nowhere to land: a pending approval is something a person has to do, and it cannot live in a
 * tab nobody drew. It goes in the context panel of Captain's own conversation — the one column in
 * the window that is *about* a conversation rather than in it.
 */
export function CaptainOperations() {
  const { t: translateText } = useTranslation("captain");
  const captain = useCaptain();
  const actions = useCaptainActions();
  const pending = captain.operations.filter(
    (item) => item.status === "pending",
  );

  return (
    <>
      <Section
        title={translateText("operations.pending")}
        count={pending.length}
      >
        {pending.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {translateText("operations.none")}
          </p>
        ) : (
          // Rows, edge to edge, as tasks and artifacts draw theirs: the rule between two runs into the
          // panel's own edges, so the block reads as part of the column and not as cards on it.
          <ul className="-mx-3 divide-y divide-border">
            {pending.map((operation) => (
              <li key={operation.id} className="px-3 py-1.5">
                <div className="font-mono text-[10px] text-muted-foreground">
                  {operation.kind}
                </div>
                {(operation.kind === "create_group" ||
                  operation.kind === "create_agent") &&
                typeof operation.payload.name === "string" ? (
                  <div className="truncate text-xs">
                    {operation.payload.name}
                  </div>
                ) : null}
                <div className="mt-1 flex gap-2">
                  <Button
                    type="button"
                    size="xs"
                    onClick={() =>
                      void actions.decideOperation.mutateAsync({
                        operationId: operation.id,
                        decision: "approve",
                      })
                    }
                  >
                    {translateText("operations.approve")}
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      void actions.decideOperation.mutateAsync({
                        operationId: operation.id,
                        decision: "reject",
                      })
                    }
                  >
                    {translateText("operations.reject")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title={translateText("assignments.title")}
        count={captain.assignments.length}
      >
        {captain.assignments.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {translateText("assignments.none")}
          </p>
        ) : (
          <ul className="-mx-3 divide-y divide-border">
            {captain.assignments.slice(0, 20).map((assignment) => (
              <li key={assignment.id} className="px-3 py-1.5 text-xs">
                <div className="flex justify-between gap-2">
                  <span>
                    {translateText("assignments.round", {
                      round: assignment.round,
                    })}
                  </span>
                  <span className="font-mono text-[10px] text-faint">
                    {assignment.status}
                  </span>
                </div>
                <p className="mt-0.5 text-muted-foreground">
                  {assignment.targets
                    .map(
                      (target) =>
                        `${target.agentId.slice(0, 8)}: ${target.status} · ${target.taskCount}`,
                    )
                    .join(" / ")}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
