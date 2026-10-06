import threading
import unittest

from django.db import IntegrityError, connection, transaction
from django.test import TestCase, TransactionTestCase

from chat import services
from chat.models import AgentCommand, Conversation, Message

from .helpers import ChatClient

postgres_only = unittest.skipUnless(
    connection.vendor == "postgresql", "composite constraints are PostgreSQL-only"
)


@postgres_only
class CompositeForeignKeyTests(TestCase):
    def test_message_agent_must_share_conversation(self):
        chat = ChatClient()
        agent = chat.create_agent()
        chat.send(agent["id"])
        command = AgentCommand.objects.get()
        stranger = Conversation.objects.create()
        with self.assertRaises(IntegrityError), transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")
            Message.objects.create(
                conversation=stranger,
                agent_id=agent["id"],
                command=command,
                seq=99,
                role="user",
                status="completed",
            )


@postgres_only
class ConcurrencyTests(TransactionTestCase):
    def test_concurrent_first_agents_share_one_default_chat(self):
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
        self.assertEqual(errors, [])
        self.assertEqual(Conversation.objects.filter(is_default=True).count(), 1)
        self.assertEqual(Conversation.objects.get(is_default=True).agents.count(), 4)
