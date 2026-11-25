import type { JSX } from "nsh";
import { context } from "nsh";

/**
 * Declares a headless UI primitive in the ui-sdk style: wires shared reactive state (typically
 * composed from atomic behaviors) into a scoped `nsh` context and exposes typed structural parts
 * (`Root` + slots) that styled components consume.
 */
export function definePrimitive<
  Options,
  State,
  Parts extends Record<string, unknown>,
>(spec: {
  name: string;
  setup: (options: Options) => State;
  parts: (useState: () => State) => Parts;
}) {
  const Scope = context<State | undefined>(undefined);

  function useState(): State {
    const state = Scope();
    if (state === undefined)
      throw new Error(
        `${spec.name} part must be rendered inside ${spec.name}.Root`,
      );
    return state;
  }

  function Root(props: Options & { children?: JSX.Element }) {
    const state = spec.setup(props);
    return <Scope.Provider value={state}>{props.children}</Scope.Provider>;
  }

  return {
    Root,
    useState,
    ...spec.parts(useState),
  };
}
