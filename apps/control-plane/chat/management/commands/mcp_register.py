import json

from django.core.management.base import BaseCommand, CommandError

from chat.control import mcp


class Command(BaseCommand):
    help = (
        "Register an immutable MCP module revision from a JSON file with "
        "module_key, revision, launch_spec and config_schema. Deployment-only."
    )

    def add_arguments(self, parser):
        parser.add_argument("spec_file")

    def handle(self, *args, spec_file, **options):
        with open(spec_file) as handle:
            spec = json.load(handle)
        try:
            revision = mcp.register_revision(
                spec["module_key"],
                str(spec["revision"]),
                spec["launch_spec"],
                spec.get("config_schema", {}),
            )
        except (KeyError, mcp.McpConfigError) as exc:
            raise CommandError(str(exc)) from exc
        self.stdout.write(f"{revision.module_key}@{revision.revision} registered")
