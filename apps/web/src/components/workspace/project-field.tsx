import type { ProjectChoice } from "./use-project-choice";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { folderName, projectPlace } from "@/lib/projects";
import { useMachines } from "@/queries/projects";
import { Select, SelectOption } from "./select-field";
import {
  useChoosable,
  useChosenProject,
  useUsableMachines,
} from "./use-project-choice";

/** The "add a directory" option; with more than one usable machine, `__add__:<machine id>` each. */
const ADD = "__add__";
/** The directory chosen to add, which stands in the list like a project until it is one. */
const CHOSEN = "__chosen__";

export function ProjectField({
  choice,
  onChange,
  onBrowse,
}: {
  choice: ProjectChoice;
  onChange: (choice: ProjectChoice) => void;
  /** Go and choose a directory, on the machine named or else wherever the choice points. */
  onBrowse: (machineId?: string) => void;
}) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  const projects = useChoosable();
  const { project, adding } = useChosenProject(choice);
  const { machines } = useMachines();
  const usable = useUsableMachines();
  const primary = machines.find((machine) => machine.kind === "primary");
  // Which machine a path goes on is a choice only once there are two to choose from, and then it is
  // made where the path is asked for: one "add" option per machine, at the end of the projects.
  const perMachine = usable.length > 1;
  const listed = projects.length > 0 || perMachine;
  const offline = (machineId: string) =>
    machines.some(
      (machine) => machine.id === machineId && machine.status !== "online",
    );
  const path = choice.path.trim();
  const chosen =
    path === "" ? (
      translateText("chat:new.pickPrompt")
    ) : (
      <>
        {folderName(path)}
        <span className="ml-1 font-mono text-muted-foreground">
          {projectPlace(
            { machineId: choice.machineId ?? primary?.id ?? "", path },
            machines,
          )}
        </span>
      </>
    );
  return (
    <div className="grid gap-1 text-sm">
      <label htmlFor="new-project">{translateText("chat:new.project")}</label>
      {listed ? (
        <Select
          id="new-project"
          className="w-full"
          value={adding ? CHOSEN : (project?.id ?? "")}
          onValueChange={(value) => {
            if (value.startsWith(ADD))
              onBrowse(value.slice(ADD.length + 1) || undefined);
            else if (value !== CHOSEN)
              onChange({ ...choice, projectId: value });
          }}
        >
          {/* With nothing chosen yet the option only names the empty field, and is not on offer. */}
          {adding ? (
            <SelectOption
              value={CHOSEN}
              disabled={path === ""}
              className={path === "" ? "hidden" : undefined}
            >
              {chosen}
            </SelectOption>
          ) : null}
          {/* The trigger shows the chosen option as it is, so the place written here is also what
              tells two projects at one path apart once one of them is chosen. */}
          {projects.map((candidate) => (
            <SelectOption key={candidate.id} value={candidate.id}>
              {candidate.name}
              <span className="ml-1 font-mono text-muted-foreground">
                {projectPlace(candidate, machines)}
                {offline(candidate.machineId)
                  ? translateText("common:status.offlineSuffix")
                  : null}
              </span>
            </SelectOption>
          ))}
          {perMachine ? (
            usable.map((machine) => (
              <SelectOption key={machine.id} value={`${ADD}:${machine.id}`}>
                {translateText("chat:new.addPathOn", { machine: machine.name })}
              </SelectOption>
            ))
          ) : (
            <SelectOption value={ADD}>
              {translateText("chat:new.addPath")}
            </SelectOption>
          )}
        </Select>
      ) : (
        <Button
          id="new-project"
          type="button"
          variant="outline"
          className="w-full justify-start overflow-hidden font-normal"
          onClick={() => onBrowse()}
        >
          <span className="truncate">{chosen}</span>
        </Button>
      )}
    </div>
  );
}
