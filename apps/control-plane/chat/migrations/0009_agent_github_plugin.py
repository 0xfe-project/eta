from django.db import migrations


def add_github(apps, schema_editor):
    # Agents made before the plugin existed get it too; until GitHub is
    # connected its tool says how to connect.
    Agent = apps.get_model("chat", "Agent")
    for agent in Agent.objects.exclude(plugins__contains=["github"]):
        agent.plugins = sorted([*agent.plugins, "github"])
        agent.save(update_fields=["plugins"])


class Migration(migrations.Migration):
    dependencies = [
        ("chat", "0008_agent_approval_plugin"),
    ]

    operations = [
        migrations.RunPython(add_github, migrations.RunPython.noop),
    ]
