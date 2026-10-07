"""Composite foreign keys that keep denormalized columns consistent (RFC §5).

Django cannot express these.
"""

from django.db import migrations

CONSTRAINTS = [
    # Messages, interactions, events and their agent share one conversation.
    (
        "message",
        "message_agent_conversation_fk",
        "(agent_id, conversation_id)",
        "agent (id, conversation_id)",
    ),
    (
        "interaction",
        "interaction_agent_conversation_fk",
        "(agent_id, conversation_id)",
        "agent (id, conversation_id)",
    ),
    (
        "agent_event",
        "agent_event_agent_conversation_fk",
        "(agent_id, conversation_id)",
        "agent (id, conversation_id)",
    ),
    # A message's command belongs to the message's agent.
    (
        "message",
        "message_command_agent_fk",
        "(command_id, agent_id)",
        "agent_command (id, agent_id)",
    ),
    # A reply points at the user message of the same agent and command.
    (
        "message",
        "message_reply_to_same_turn_fk",
        "(reply_to_id, agent_id, command_id)",
        "message (id, agent_id, command_id)",
    ),
    # Commands, approvals and interactions stay within one agent.
    (
        "agent_command",
        "agent_command_runtime_agent_fk",
        "(runtime_instance_id, agent_id)",
        "runtime_instance (id, agent_id)",
    ),
    (
        "approval",
        "approval_command_agent_fk",
        "(command_id, agent_id)",
        "agent_command (id, agent_id)",
    ),
    (
        "approval",
        "approval_runtime_agent_fk",
        "(runtime_instance_id, agent_id)",
        "runtime_instance (id, agent_id)",
    ),
    (
        "interaction",
        "interaction_approval_agent_fk",
        "(approval_id, agent_id)",
        "approval (id, agent_id)",
    ),
    (
        "agent_mcp_binding",
        "agent_mcp_binding_module_key_fk",
        "(module_revision_id, module_key)",
        "mcp_module_revision (id, module_key)",
    ),
]


class Migration(migrations.Migration):
    dependencies = [("chat", "0001_initial")]

    operations = [
        migrations.RunSQL(
            f"ALTER TABLE {table} ADD CONSTRAINT {name} "
            f"FOREIGN KEY {columns} REFERENCES {target} DEFERRABLE INITIALLY DEFERRED",
            f"ALTER TABLE {table} DROP CONSTRAINT {name}",
        )
        for table, name, columns, target in CONSTRAINTS
    ]
