from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("chat", "0003_builtin_tasks_module")]

    operations = [
        migrations.AddField(
            model_name="agent",
            name="description",
            field=models.TextField(blank=True, default=""),
        ),
        # The version now covers instructions as well as MCP bindings.
        migrations.RemoveConstraint(model_name="agent", name="agent_counters_valid"),
        migrations.RenameField(
            model_name="agent", old_name="mcp_config_version", new_name="config_version"
        ),
        migrations.RenameField(
            model_name="runtimeinstance",
            old_name="mcp_config_version",
            new_name="config_version",
        ),
        migrations.AddConstraint(
            model_name="agent",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    ("config_version__gte", 0),
                    ("generation__gte", 0),
                    ("last_command_seq__gte", 0),
                    ("product_revision__gte", 1),
                ),
                name="agent_counters_valid",
            ),
        ),
    ]
