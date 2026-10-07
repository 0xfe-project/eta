from unittest import mock

import pytest

from chat import llm

from .helpers import TEST_MODEL, ChatClient


@pytest.fixture(autouse=True)
def llm_catalog():
    """Every chat goes through the LLM gateway; offer one available model."""
    catalog = {
        TEST_MODEL: llm.Model(
            id=TEST_MODEL,
            connector="test",
            display_name="Test Model",
            context_window=None,
            available=True,
            unavailable_message=None,
        )
    }
    llm.clear_cache()
    with mock.patch("chat.llm._fetch", return_value=catalog):
        yield
    llm.clear_cache()


@pytest.fixture
def chat():
    return ChatClient()


@pytest.fixture
def agent(chat):
    return chat.create_agent()
