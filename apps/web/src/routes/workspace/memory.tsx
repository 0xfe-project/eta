import { createFileRoute } from "@tanstack/react-router";
import { MemoryPage } from "@/pages/memory";

export const Route = createFileRoute("/workspace/memory")({
  component: MemoryPage,
});
