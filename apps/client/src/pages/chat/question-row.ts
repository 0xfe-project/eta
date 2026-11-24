/** Where the transcript row that carries a question is, or undefined when the question is not on a
 * loaded row (it has no reply, or the reply is older than what is loaded). */
export function questionRowIndex(
  rows: readonly { id: string }[],
  replyId: string | null,
): number | undefined {
  if (replyId === null) return undefined;
  const index = rows.findIndex((row) => row.id === replyId);
  return index < 0 ? undefined : index;
}

/** Where a question came from, when the client can take the user there. */
export type QuestionSource =
  | { kind: "row"; index: number }
  | { kind: "task"; taskId: string };

/**
 * The reply row that carries the question when it is loaded, else the task whose run asked it
 * (a run's session is the question's session), else nothing.
 */
export function questionSource(
  question: { replyId: string | null; sessionId: string },
  rows: readonly { id: string }[],
  tasks: readonly {
    id: string;
    runs: readonly { sessionId: string | null }[];
  }[],
): QuestionSource | undefined {
  const index = questionRowIndex(rows, question.replyId);
  if (index !== undefined) return { kind: "row", index };
  const task = tasks.find((entry) =>
    entry.runs.some((run) => run.sessionId === question.sessionId),
  );
  return task && { kind: "task", taskId: task.id };
}

/** The questions among `pending` that one of `runs` asked (a run's session is its question's), oldest first. */
export function questionsOfRuns<
  T extends { sessionId: string; createdAt: number },
>(pending: readonly T[], runs: readonly { sessionId: string | null }[]): T[] {
  const sessions = new Set(runs.map((run) => run.sessionId));
  return pending
    .filter((item) => sessions.has(item.sessionId))
    .sort((a, b) => a.createdAt - b.createdAt);
}
