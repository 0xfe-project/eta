import os
import shutil
import sys
import uuid
from pathlib import Path

import pytest

from axp_runtime import plugins, routine
from axp_runtime.config import Settings

FAKE = [sys.executable, "-m", "axp_runtime.testing.fake_app_server"]
os.environ["PYTHONPATH"] = str(Path(__file__).resolve().parent.parent)


@pytest.fixture(scope="module")
def plugins_dir(tmp_path_factory):
    """The image's plugins as built, minus their setup."""
    root = tmp_path_factory.mktemp("image") / "plugins"
    shutil.copytree(Path(__file__).resolve().parent.parent / "plugins", root)
    plugins.write_marketplace(root)
    return root


def settings(tmp_path, plugins_dir) -> Settings:
    return Settings(
        agent_id="routine-1",
        instance_id=str(uuid.uuid4()),
        generation=0,
        token="secret",
        gateway_url="http://gateway.invalid",
        home_dir=tmp_path / "home",
        known_thread_id=None,
        model=None,
        developer_instructions="你在执行定时任务「日报」。",
        codex_launch=FAKE,
        plugins_dir=plugins_dir,
    )


def test_a_run_is_one_turn_with_its_own_plugins(tmp_path, plugins_dir):
    s = settings(tmp_path, plugins_dir)
    completed, message = routine.run(s, "现在执行这次运行。")
    assert completed
    assert message == "收到：现在执行这次运行。"
    installed = {p.name for p in (s.codex_home / "plugins/cache/axp").iterdir()}
    assert installed == {"routine", "grok"}


def test_failed_turn(tmp_path, plugins_dir):
    assert routine.run(settings(tmp_path, plugins_dir), "[fail]")[0] is False


def test_nobody_is_asked():
    method = "item/commandExecution/requestApproval"
    assert routine._approve(method, {}) == {"decision": "accept"}
    elicitation = routine._approve("mcpServer/elicitation/request", {})
    assert elicitation == {"action": "accept", "content": {}}
    assert routine._approve("item/permissions/requestApproval", {}) == {
        "permissions": {}
    }
