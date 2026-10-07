import pytest

from .helpers import ChatClient


@pytest.fixture
def chat():
    return ChatClient()


@pytest.fixture
def agent(chat):
    return chat.create_agent()
