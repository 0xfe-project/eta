from django.db import migrations


def add_approval(apps, schema_editor):
    # The image's rules ask the user through the approval plugin's tool; agents
    # made before it existed get it too.
    Agent = apps.get_model("chat", "Agent")
    for agent in Agent.objects.exclude(plugins__contains=["approval"]):
        agent.plugins = sorted([*agent.plugins, "approval"])
        agent.save(update_fields=["plugins"])


class Migration(migrations.Migration):
    dependencies = [
        ("chat", "0007_agent_plugins"),
    ]

    operations = [
        migrations.RunPython(add_approval, migrations.RunPython.noop),
    ]
