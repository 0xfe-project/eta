from django.db import migrations, models


def workspace_paths(apps, schema_editor):
    # Every workspace lives on JuiceFS; earlier Docker volumes are left as is.
    AgentStorage = apps.get_model("chat", "AgentStorage")
    for storage in AgentStorage.objects.all():
        storage.workspace_path = f"agents/{storage.agent_id}/workspace"
        storage.save(update_fields=["workspace_path"])


class Migration(migrations.Migration):
    dependencies = [("chat", "0004_agent_description")]

    operations = [
        migrations.RemoveConstraint(
            model_name="agentstorage", name="agent_storage_workspace_uniq"
        ),
        migrations.RemoveConstraint(
            model_name="agentstorage", name="agent_storage_backend_valid"
        ),
        migrations.RemoveField(model_name="agentstorage", name="workspace_backend"),
        migrations.RemoveField(model_name="agentstorage", name="volume_ref"),
        migrations.RemoveField(model_name="agentstorage", name="subpath"),
        migrations.AddField(
            model_name="agentstorage",
            name="workspace_path",
            field=models.CharField(max_length=300, null=True),
        ),
        migrations.RunPython(workspace_paths, migrations.RunPython.noop),
        migrations.AlterField(
            model_name="agentstorage",
            name="workspace_path",
            field=models.CharField(max_length=300, unique=True),
        ),
    ]
