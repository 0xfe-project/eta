import type { AssigneeDraft } from "./assignee-draft";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePlaces, useTasks } from "@/queries/tasks";
import { emptyDraft, placeKey } from "./assignee-draft";
import { AssigneeMenu } from "./assignee-menu";
import { Select, SelectGroup, SelectOption } from "./select-field";
import { assigneeFromKey } from "./task-format";

// Who a task is for, and for a remote agent where it works: one of the
// computer's existing workspaces, or a new worktree its runtime creates.

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      {children}
    </div>
  );
}

/** The assignee select and, for a remote agent, its place. */
export function AssigneeFields({
  id,
  draft,
  onChange,
}: {
  id: string;
  draft: AssigneeDraft;
  onChange: (draft: AssigneeDraft) => void;
}) {
  const { t: translateText } = useTranslation();
  const tasks = useTasks();
  const assignee = assigneeFromKey(draft.key);
  const remote = assignee.kind === "remote";
  const places = usePlaces(
    remote ? (assignee.computer_id ?? null) : null,
    remote ? (assignee.runtime ?? null) : null,
  );
  const knownPlace = [
    ...(places.data?.projects.map((p) =>
      placeKey("worktree", p.id, p.session),
    ) ?? []),
    ...(places.data?.workspaces.map((w) =>
      placeKey("workspace", w.id, w.session),
    ) ?? []),
  ].includes(draft.place);
  const worktree = draft.place.startsWith("worktree");
  return (
    <div className="grid gap-3">
      <Field id={`${id}-assignee`} label={translateText("指派给")}>
        <AssigneeMenu
          id={`${id}-assignee`}
          value={draft.key}
          options={tasks.data?.assignees ?? []}
          pending={tasks.isPending}
          error={tasks.error?.message}
          retry={() => {
            void tasks.refetch();
          }}
          onChange={(value) => {
            if (value !== draft.key) onChange({ ...emptyDraft, key: value });
          }}
        />
      </Field>
      {remote ? (
        <Field id={`${id}-place`} label={translateText("工作位置")}>
          {places.error ? (
            <div className="grid gap-1">
              <p className="text-xs text-destructive">{places.error.message}</p>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  void places.refetch();
                }}
              >
                {translateText("重试")}
              </Button>
            </div>
          ) : (
            <Select
              id={`${id}-place`}
              className="w-full"
              value={draft.place}
              disabled={places.isPending}
              onValueChange={(value) => onChange({ ...draft, place: value })}
            >
              <SelectOption value="">
                {places.isPending
                  ? translateText("读取那台电脑上的项目……")
                  : translateText("选择工作位置")}
              </SelectOption>
              {draft.place && !knownPlace ? (
                <SelectOption value={draft.place} disabled>
                  {translateText("当前工作位置（{{value1}}）{{value2}}", {
                    value1: draft.place.split("\u0000")[1],
                    value2: places.isPending ? "" : translateText(" · 不可用"),
                  })}
                </SelectOption>
              ) : null}
              {places.data?.projects.length ? (
                <SelectGroup label={translateText("新开一个 worktree")}>
                  {places.data.projects.map((p) => (
                    <SelectOption
                      key={`w${p.id}`}
                      value={placeKey("worktree", p.id, p.session)}
                    >
                      {translateText("从 {{value1}} 开（{{value2}}）", {
                        value1: p.name,
                        value2: p.path,
                      })}
                    </SelectOption>
                  ))}
                </SelectGroup>
              ) : null}
              {places.data?.workspaces.length ? (
                <SelectGroup label={translateText("在已有的工作区里")}>
                  {places.data.workspaces.map((w) => (
                    <SelectOption
                      key={`s${w.id}`}
                      value={placeKey("workspace", w.id, w.session)}
                    >
                      {w.name}
                      {w.branch ? ` · ${w.branch}` : ""}
                      {w.dirty ? translateText(" · 有未提交改动") : ""}（
                      {w.path}）
                    </SelectOption>
                  ))}
                </SelectGroup>
              ) : null}
            </Select>
          )}
        </Field>
      ) : null}
      {remote && worktree ? (
        <div className="grid grid-cols-2 gap-3">
          <Field id={`${id}-branch`} label={translateText("分支（可选）")}>
            <Input
              id={`${id}-branch`}
              placeholder={translateText("默认 axp/<编号>-<标题>")}
              maxLength={200}
              value={draft.branch}
              onChange={(e) => onChange({ ...draft, branch: e.target.value })}
            />
          </Field>
          <Field id={`${id}-base`} label={translateText("从哪里开（可选）")}>
            <Input
              id={`${id}-base`}
              placeholder={translateText("默认当前分支")}
              maxLength={200}
              value={draft.base}
              onChange={(e) => onChange({ ...draft, base: e.target.value })}
            />
          </Field>
        </div>
      ) : null}
    </div>
  );
}
