import threading

import pytest
from django.db import IntegrityError, connection, transaction

from chat import services
from chat.models import AgentCommand, Conversation, Message

pytestmark = pytest.mark.django_db


def test_message_agent_must_share_conversation(chat, agent):
    chat.send(agent["id"])
    command = AgentCommand.objects.get()
    stranger = Conversation.objects.create()
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")
        with pytest.raises(IntegrityError), transaction.atomic():
            Message.objects.create(
                conversation=stranger,
                agent_id=agent["id"],
                command=command,
                seq=99,
                role="user",
                status="completed",
            )


@pytest.mark.django_db(transaction=True)
def test_concurrent_first_agents_share_one_default_chat():
    barrier = threading.Barrier(4)
    errors = []

    def create(i):
        try:
            barrier.wait()
            with transaction.atomic():
                services.create_agent(f"agent-{i}")
        except Exception as exc:  # pragma: no cover - reported below
            errors.append(exc)
        finally:
            connection.close()

    threads = [threading.Thread(target=create, args=(i,)) for i in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert errors == []
    default = Conversation.objects.get(is_default=True)
    assert default.agents.count() == 4
