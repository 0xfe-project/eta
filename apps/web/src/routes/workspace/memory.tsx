import { createFileRoute } from "@tanstack/react-router";
import { validateMemorySearch } from "@/components/workspace/memory-nav";
import { MemoryPage } from "@/pages/memory";

export const Route = createFileRoute("/workspace/memory")({
  validateSearch: validateMemorySearch,
  component: MemoryPage,
});
