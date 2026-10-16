/** JSON-serializable values — the only data allowed to cross the journal. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
