import type { ProjectChoice } from "./use-project-choice";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { host, pickFolder } from "@/lib/native";
import { Select, SelectOption } from "./select-field";
import {
  useChoosable,
  useChosenProject,
  useUsableMachines,
} from "./use-project-choice";

const ADD = "__add__";

export function ProjectField({
  choice,
  onChange,
}: {
  choice: ProjectChoice;
  onChange: (choice: ProjectChoice) => void;
}) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  const projects = useChoosable();
  const { project, adding } = useChosenProject(choice);
  const machines = useUsableMachines();
  const primary = machines.find((machine) => machine.kind === "primary");
  const machineId = choice.machineId ?? primary?.id ?? "";
  // A folder dialog sees this machine's disk, so it is offered only while the path would be added
  // on this machine. A path on a daemon is still typed by hand — and that is not a gap: the folder
  // being picked is not on the disk in front of the user.
  const canPick =
    host().kind === "desktop" && machineId === (primary?.id ?? "");
  const choose = async () => {
    const picked = await pickFolder(choice.path.trim() || undefined);
    if (picked !== null) onChange({ ...choice, path: picked });
  };
  return (
    <div className="grid gap-1 text-sm">
      <label htmlFor="new-project">{translateText("chat:new.project")}</label>
      {projects.length > 0 ? (
        <Select
          id="new-project"
          className="w-full"
          value={adding ? ADD : (project?.id ?? "")}
          onValueChange={(value) =>
            onChange({ ...choice, projectId: value === ADD ? "" : value })
          }
        >
          {projects.map((candidate) => (
            <SelectOption key={candidate.id} value={candidate.id}>
              {candidate.name}
              <span className="ml-1 font-mono text-muted-foreground">
                {candidate.path}
              </span>
            </SelectOption>
          ))}
          <SelectOption value={ADD}>
            {translateText("chat:new.addPath")}
          </SelectOption>
        </Select>
      ) : null}
      {adding ? (
        <>
          {machines.length > 1 ? (
            <Select
              aria-label={translateText("chat:new.machine")}
              className="w-full"
              value={machineId}
              onValueChange={(value) =>
                onChange({
                  ...choice,
                  machineId: value === primary?.id ? undefined : value,
                })
              }
            >
              {machines.map((machine) => (
                <SelectOption key={machine.id} value={machine.id}>
                  {machine.name}
                </SelectOption>
              ))}
            </Select>
          ) : null}
          <Input
            id={projects.length > 0 ? undefined : "new-project"}
            aria-label={translateText("chat:new.path")}
            value={choice.path}
            onChange={(event) =>
              onChange({ ...choice, path: event.target.value })
            }
            placeholder={translateText("chat:groups.fields.cwdPlaceholder")}
            spellCheck={false}
            className="font-mono"
          />
          {canPick ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="justify-self-start"
              onClick={() => void choose()}
            >
              {translateText("chat:new.chooseFolder")}
            </Button>
          ) : null}
          <span className="text-xs text-muted-foreground">
            {translateText("chat:new.pathHint")}
          </span>
        </>
      ) : (
        <span className="truncate font-mono text-xs text-muted-foreground">
          {project?.path}
        </span>
      )}
    </div>
  );
}
