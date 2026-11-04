/**
 * A runtime's models, as a session's model layer.
 *
 * A session resolves its model choice against its model layer (`modelSet` refuses a name nobody
 * serves, the thinking levels on offer come from the model). For a session a runtime answers in,
 * that layer is the runtime's own catalog, under the runtime's name as the provider:
 * `claude:sonnet`, `codex:gpt-6-luna`. Nothing here generates: the runtime does.
 *
 * A name the catalog does not list still resolves while the catalog is unknown, and always for a
 * runtime that takes names beyond its list (claude takes full model ids as well as its aliases).
 */
import type { Api, KernelModels, Model, ThinkingLevel } from "@eta/core";
import type { RuntimeCatalog, RuntimeId, RuntimeModel } from "./catalog";
import { THINKING_LEVELS } from "@eta/core";

/** The runtimes whose `--model` takes names their list does not show. */
const OPEN_NAMES: ReadonlySet<RuntimeId> = new Set(["claude", "codex"]);

/**
 * The effort a runtime is asked for at a thinking level: the level itself where the model takes
 * it, `minimal` falling back to `low`. `off` (and a level the model lacks) asks for nothing, and
 * the runtime runs its own default.
 */
export function effortFor(
  level: ThinkingLevel,
  efforts: readonly string[] | undefined,
): string | undefined {
  if (level === "off") return undefined;
  if (efforts === undefined) return level;
  if (efforts.includes(level)) return level;
  if (level === "minimal" && efforts.includes("low")) return "low";
  return undefined;
}

function modelOf(
  runtime: RuntimeId,
  id: string,
  listed: RuntimeModel | undefined,
): Model<Api> {
  const efforts = listed?.efforts;
  return {
    id,
    name: listed?.name ?? id,
    api: `oar-${runtime}`,
    provider: runtime,
    baseUrl: "",
    // A model that names no effort levels still thinks as the runtime decides; only one the
    // catalog lists with none is held to `off`.
    reasoning: efforts === undefined || efforts.length > 0,
    ...(efforts === undefined
      ? {}
      : {
          thinkingLevelMap: Object.fromEntries(
            THINKING_LEVELS.filter((level) => level !== "off").map((level) => [
              level,
              effortFor(level, efforts) ?? null,
            ]),
          ),
        }),
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
  } as Model<Api>;
}

export function runtimeModels(
  runtime: RuntimeId,
  catalog: RuntimeCatalog,
): KernelModels {
  const refuse = (): never => {
    throw new Error(
      `${runtime} generates on its own; eta does not call its models`,
    );
  };
  return {
    getModel: (provider: string, id: string) => {
      if (provider !== runtime) return undefined;
      const info = catalog.peek(runtime);
      const listed = info?.models.find((model) => model.id === id);
      if (
        listed === undefined &&
        info?.status === "available" &&
        info.models.length > 0 &&
        !OPEN_NAMES.has(runtime)
      )
        return undefined;
      return modelOf(runtime, id, listed);
    },
    streamSimple: refuse,
    completeSimple: refuse,
  } as unknown as KernelModels;
}
