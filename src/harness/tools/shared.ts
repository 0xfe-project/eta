/** Shared tool-result helper: one text line plus structured details for the UI. */
export const withId = <T>(id: string, extra: T) => ({ content: [{ type: "text" as const, text: id }], details: extra });
