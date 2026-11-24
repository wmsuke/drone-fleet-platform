from types import SimpleNamespace
import importlib.util
import json
from pathlib import Path
import signal
import threading
import uuid

import pytest

spec = importlib.util.spec_from_file_location(
    "execution_barrier", Path(__file__).resolve().parents[3] / "tools/execution_barrier.py")
testing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(testing)


@pytest.mark.parametrize("enabled,selected,device", [
    ("false", "ros-recovery-generation", "ros-recovery-generation"),
    ("true", "other", "ros-recovery-generation"),
    ("true", "ros-demo-success", "ros-demo-success"),
])
def test_normal_and_other_devices_never_pause(monkeypatch, tmp_path, enabled, selected, device):
    monkeypatch.setenv("BRIDGE_INTEGRATION", enabled)
    monkeypatch.setenv("REFERENCE_TEST_EXECUTION_BARRIER", selected)
    monkeypatch.setattr(testing, "BARRIER_PATH", tmp_path / "proof.json")
    monkeypatch.setattr(testing.os, "kill", lambda *args: pytest.fail("unexpected signal"))
    testing.execution_barrier(SimpleNamespace(config=SimpleNamespace(device_id=device)), None)
    assert not testing.BARRIER_PATH.exists()


def test_execution_proof_precedes_process_stop(monkeypatch, tmp_path):
    monkeypatch.setenv("BRIDGE_INTEGRATION", "true")
    monkeypatch.setenv("REFERENCE_TEST_EXECUTION_BARRIER", "ros-recovery-generation")
    monkeypatch.setattr(testing, "BARRIER_PATH", tmp_path / "proof.json")
    goal = uuid.uuid4()
    state = SimpleNamespace(config=SimpleNamespace(device_id="ros-recovery-generation"),
                            server_id=str(uuid.uuid4()), accepted=1, executions=1,
                            last_terminal=None)
    handle = SimpleNamespace(request=SimpleNamespace(command_id=str(uuid.uuid4())),
                             goal_id=SimpleNamespace(uuid=list(goal.bytes)), status=2)
    calls = []

    def kill(pid, name):
        proof = json.loads(testing.BARRIER_PATH.read_text())
        assert proof["pid"] == pid
        assert proof["rosStatus"] == 2
        assert proof["goalId"] == str(goal)
        assert proof["commandId"] == handle.request.command_id
        assert proof["hasTerminal"] is False
        assert proof["acceptedCount"] == proof["executionCount"] == 1
        calls.append(name)

    monkeypatch.setattr(testing.os, "kill", kill)
    testing.execution_barrier(state, handle)
    assert calls == [signal.SIGSTOP]


def test_only_execution_thread_enters_barrier(monkeypatch):
    from fleet_reference.nodes import ReferenceAdapter, State

    previous_execute, previous_check = ReferenceAdapter.execute, State.check
    tools = Path(__file__).resolve().parents[3] / "tools"
    monkeypatch.syspath_prepend(str(tools))
    module_spec = importlib.util.spec_from_file_location(
        "reference_test_server", tools / "reference_test_server.py")
    wrapper = importlib.util.module_from_spec(module_spec)
    try:
        module_spec.loader.exec_module(wrapper)
        calls = []
        monkeypatch.setattr(wrapper, "execution_barrier", lambda *args: calls.append(args))
        monkeypatch.setattr(wrapper, "original_check", lambda state: "ORIGINAL_CHECK")
        handle = object()
        state = SimpleNamespace(_test_execution_handle=handle,
                                _test_execution_thread=threading.get_ident() + 1)
        assert wrapper.check(state) == "ORIGINAL_CHECK"
        assert calls == []  # runtime照会等の別threadは制約を検査するだけ。
        state._test_execution_thread = threading.get_ident()
        assert wrapper.check(state) == "ORIGINAL_CHECK"
        assert calls == [(state, handle)]
    finally:
        ReferenceAdapter.execute, State.check = previous_execute, previous_check
