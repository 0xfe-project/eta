"""Register the runtime image's built-in ``tasks`` MCP module."""

from django.db import migrations

LAUNCH_SPEC = {"command": "python", "args": ["-m", "axp_runtime.mcp_tasks"], "env": {}}
CONFIG_SCHEMA = {
    "type": "object",
    "properties": {"max_tasks": {"type": "integer", "minimum": 1, "maximum": 1000}},
    "additionalProperties": False,
}


def register(apps, schema_editor):
    McpModuleRevision = apps.get_model("chat", "McpModuleRevision")
    McpModuleRevision.objects.get_or_create(
        module_key="tasks",
        revision="1",
        defaults={"launch_spec": LAUNCH_SPEC, "config_schema": CONFIG_SCHEMA},
    )


def unregister(apps, schema_editor):
    apps.get_model("chat", "McpModuleRevision").objects.filter(
        module_key="tasks", revision="1", bindings__isnull=True
    ).delete()


class Migration(migrations.Migration):
    dependencies = [("chat", "0002_composite_foreign_keys")]

    operations = [migrations.RunPython(register, unregister)]
