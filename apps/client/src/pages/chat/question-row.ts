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
