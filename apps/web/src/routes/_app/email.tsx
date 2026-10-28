import { createFileRoute } from "@tanstack/react-router";
import { validateEmailSearch } from "@/components/workspace/email-nav";
import { EmailInboxPage } from "@/pages/email-inbox";

export const Route = createFileRoute("/_app/email")({
  validateSearch: validateEmailSearch,
  component: EmailInboxPage,
});
