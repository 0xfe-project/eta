import { PlusIcon } from "@phosphor-icons/react/Plus";
import { XIcon } from "@phosphor-icons/react/X";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useApprovals, useSetApprovals } from "@/queries/inbox";
import { useSession } from "@/queries/sessions";
import { useGroups } from "./use-groups";

/**
 * The tools that ask first. The list is the host's, for every session: a listed tool stops at a
 * question (allow or deny, in the inbox) before each call. Names are free text; the tools of the
 * open conversation's session are offered as suggestions.
 */
export function ApprovalSettings() {
  const { t: translateText } = useTranslation(["settings", "common"] as const);
  const approvals = useApprovals();
  const setApprovals = useSetApprovals();
  const { current } = useGroups();
  const member =
    current?.participants.find((entry) => entry.sessionId !== null) ??
    undefined;
  const tools = useSession(member?.sessionId)?.tools;
  const [name, setName] = useState("");
  const listId = useId();
  const suggestions = (tools ?? []).filter(
    (tool) => !approvals.includes(tool.name),
  );

  const save = (next: string[], onSuccess?: () => void) =>
    setApprovals.mutate(
      { tools: next },
      { onSuccess, onError: (error) => toast.error(error.message) },
    );
  const add = () => {
    const value = name.trim();
    if (value === "" || approvals.includes(value)) return;
    save([...approvals, value], () => setName(""));
  };

  return (
    <div>
      <div className="settings-heading">
        <h2>{translateText("sections.approvals")}</h2>
        <p>{translateText("approvals.description")}</p>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <Input
          aria-label={translateText("approvals.toolName")}
          placeholder={translateText("approvals.placeholder")}
          list={listId}
          value={name}
          maxLength={200}
          onChange={(event) => setName(event.target.value)}
        />
        <datalist id={listId}>
          {suggestions.map((tool) => (
            <option key={tool.name} value={tool.name}>
              {tool.description}
            </option>
          ))}
        </datalist>
        <Button
          type="submit"
          disabled={
            name.trim() === "" ||
            approvals.includes(name.trim()) ||
            setApprovals.isPending
          }
        >
          <PlusIcon aria-hidden="true" data-icon="inline-start" />
          {translateText("approvals.add")}
        </Button>
      </form>
      {approvals.length === 0 ? (
        <p className="settings-hint">{translateText("approvals.empty")}</p>
      ) : (
        <ul
          aria-label={translateText("sections.approvals")}
          className="mt-3 divide-y border"
        >
          {approvals.map((tool) => (
            <li
              key={tool}
              className="flex items-center gap-2 px-3 py-1.5 text-sm"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                {tool}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={translateText("common:actions.removeItem", {
                  name: tool,
                })}
                disabled={setApprovals.isPending}
                onClick={() => save(approvals.filter((t) => t !== tool))}
              >
                <XIcon aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
