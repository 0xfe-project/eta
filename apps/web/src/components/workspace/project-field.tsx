import type { ProjectChoice } from "./use-project-choice";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { host, pickFolder } from "@/lib/native";
import { projectPlace } from "@/lib/projects";
import { useMachines } from "@/queries/projects";
import { Select, SelectOption } from "./select-field";
import {
  useChoosable,
  useChosenProject,
  useUsableMachines,
} from "./use-project-choice";

/** The "add a directory" option; with more than one usable machine, `__add__:<machine id>` each. */
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
  const { machines } = useMachines();
  const usable = useUsableMachines();
  const primary = machines.find((machine) => machine.kind === "primary");
  // Which machine a path goes on is a choice only once there are two to choose from, and then it is
  // made where the path is asked for: one "add" option per machine, at the end of the projects.
  const perMachine = usable.length > 1;
  const listed = projects.length > 0 || perMachine;
  // A folder dialog sees this machine's disk, so it is offered only while the path would be added
  // on this machine. A path on a daemon is still typed by hand — and that is not a gap: the folder
  // being picked is not on the disk in front of the user.
  const canPick =
    host().kind === "desktop" &&
    (choice.machineId ?? primary?.id) === primary?.id;
  const choose = async () => {
    const picked = await pickFolder(choice.path.trim() || undefined);
    if (picked !== null) onChange({ ...choice, path: picked });
  };
  const offline = (machineId: string) =>
    machines.some(
      (machine) => machine.id === machineId && machine.status !== "online",
    );
  return (
    <div className="grid gap-1 text-sm">
      <label htmlFor="new-project">{translateText("chat:new.project")}</label>
      {listed ? (
        <Select
          id="new-project"
          className="w-full"
          value={
            adding
              ? perMachine
                ? `${ADD}:${choice.machineId ?? primary?.id ?? ""}`
                : ADD
              : (project?.id ?? "")
          }
          onValueChange={(value) =>
            onChange(
              value.startsWith(ADD)
                ? {
                    ...choice,
                    projectId: "",
                    machineId: value.slice(ADD.length + 1) || undefined,
                  }
                : { ...choice, projectId: value },
            )
          }
        >
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
      ) : null}
      {adding ? (
        <>
          <Input
            id={listed ? undefined : "new-project"}
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
      ) : null}
    </div>
  );
}
