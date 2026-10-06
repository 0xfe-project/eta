import json

from django.core.management.base import BaseCommand, CommandError

from chat.control import mcp
from chat.models import Agent, McpModuleRevision


class Command(BaseCommand):
    help = "Bind an MCP module revision to an agent (takes effect on next start)."

    def add_arguments(self, parser):
        parser.add_argument("agent_id")
        parser.add_argument("module_key")
        parser.add_argument("--revision")
        parser.add_argument("--required", action="store_true")
        parser.add_argument("--disable", action="store_true")
        parser.add_argument("--tools", default="", help="comma-separated allowlist")
        parser.add_argument("--config", default="{}", help="JSON config")
        parser.add_argument("--secret-ref", help="env:NAME")

    def handle(self, *args, **options):
        agent = Agent.objects.filter(pk=options["agent_id"]).first()
        if agent is None:
            raise CommandError("agent not found")
        revisions = McpModuleRevision.objects.filter(
            module_key=options["module_key"], enabled=True
        )
        if options["revision"]:
            revisions = revisions.filter(revision=options["revision"])
        revision = revisions.order_by("-created_at").first()
        if revision is None:
            raise CommandError("module revision not found")
        try:
            mcp.bind(
                agent,
                revision,
                required=options["required"],
                allowed_tools=[t for t in options["tools"].split(",") if t],
                config=json.loads(options["config"]),
                secret_ref=options["secret_ref"],
                enabled=not options["disable"],
            )
        except (ValueError, mcp.McpConfigError) as exc:
            raise CommandError(str(exc)) from exc
        self.stdout.write(f"bound {revision.module_key}@{revision.revision}")
