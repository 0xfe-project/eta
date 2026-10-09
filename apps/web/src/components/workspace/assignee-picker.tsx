import type { AssigneeDraft } from "./assignee-draft";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePlaces, useTasks } from "@/queries/tasks";
import { emptyDraft, placeKey } from "./assignee-draft";
import { Select, SelectGroup, SelectOption } from "./select-field";
import { assigneeFromKey, assigneeOptions } from "./task-format";

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
  const { data } = useTasks();
  const options = assigneeOptions(data?.assignees ?? []);
  const assignee = assigneeFromKey(draft.key);
  const remote = assignee.kind === "remote";
  const places = usePlaces(
    remote ? (assignee.computer_id ?? null) : null,
    remote ? (assignee.runtime ?? null) : null,
  );
  const known = options.some((o) => o.key === draft.key);
  const worktree = draft.place.startsWith("worktree");
  return (
    <div className="grid gap-3">
      <Field id={`${id}-assignee`} label="指派给">
        <Select
          id={`${id}-assignee`}
          className="w-full"
          value={draft.key}
          onValueChange={(value) => onChange({ ...emptyDraft, key: value })}
        >
          {known ? null : (
            <SelectOption value={draft.key}>不可用的远程智能体</SelectOption>
          )}
          {options.map((o) => (
            <SelectOption key={o.key} value={o.key}>
              {o.label}
            </SelectOption>
          ))}
        </Select>
      </Field>
      {remote ? (
        <Field id={`${id}-place`} label="工作位置">
          {places.error ? (
            <p className="text-xs text-destructive">{places.error.message}</p>
          ) : (
            <Select
              id={`${id}-place`}
              className="w-full"
              value={draft.place}
              disabled={places.isPending}
              onValueChange={(value) => onChange({ ...draft, place: value })}
            >
              <SelectOption value="">
                {places.isPending ? "读取那台电脑上的项目……" : "选择工作位置"}
              </SelectOption>
              {places.data?.projects.length ? (
                <SelectGroup label="新开一个 worktree">
                  {places.data.projects.map((p) => (
                    <SelectOption
                      key={`w${p.id}`}
                      value={placeKey("worktree", p.id, p.session)}
                    >
                      从 {p.name} 开（{p.path}）
                    </SelectOption>
                  ))}
                </SelectGroup>
              ) : null}
              {places.data?.workspaces.length ? (
                <SelectGroup label="在已有的工作区里">
                  {places.data.workspaces.map((w) => (
                    <SelectOption
                      key={`s${w.id}`}
                      value={placeKey("workspace", w.id, w.session)}
                    >
                      {w.name}
                      {w.branch ? ` · ${w.branch}` : ""}
                      {w.dirty ? " · 有未提交改动" : ""}（{w.path}）
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
          <Field id={`${id}-branch`} label="分支（可选）">
            <Input
              id={`${id}-branch`}
              placeholder="默认 axp/<编号>-<标题>"
              maxLength={200}
              value={draft.branch}
              onChange={(e) => onChange({ ...draft, branch: e.target.value })}
            />
          </Field>
          <Field id={`${id}-base`} label="从哪里开（可选）">
            <Input
              id={`${id}-base`}
              placeholder="默认当前分支"
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
