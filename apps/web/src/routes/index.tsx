import { createFileRoute } from "@tanstack/react-router";
import {
  createStandardSchemaV1,
  parseAsStringLiteral,
  useQueryState,
} from "nuqs";
import { Workspace } from "@/components/workspace/workspace";

const viewParser = parseAsStringLiteral([
  "overview",
  "tasks",
  "memory",
  "capabilities",
] as const)
  .withDefault("overview")
  .withOptions({ history: "push" });

export const Route = createFileRoute("/")({
  validateSearch: createStandardSchemaV1(
    { view: viewParser },
    { partialOutput: true },
  ),
  component: Home,
});

function Home() {
  const [view, setView] = useQueryState("view", viewParser);
  return (
    <Workspace view={view} onViewChange={(value) => void setView(value)} />
  );
}
