"""照会だけの有界再試行。応答なしを成功や実行再送に置き換えない。"""

import importlib.util
from unittest.mock import Mock

import pytest


def probe():
    spec = importlib.util.spec_from_file_location(
        "probe_action", "/workspace/tools/probe_action.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_read_retries_timeout_and_returns_only_real_response(monkeypatch):
    module = probe()
    monkeypatch.setattr(module.rclpy, "spin_until_future_complete", Mock())
    first, second = Mock(), Mock()
    first.done.return_value = False
    second.done.return_value = True
    second.result.return_value = object()
    node = Mock()
    client = node.create_client.return_value
    client.call_async.side_effect = [first, second]
    assert module.query(node, object, "/read", object()) is second.result.return_value
    client.remove_pending_request.assert_called_once_with(first)
    first.cancel.assert_called_once()
    assert client.call_async.call_count == 2


def test_read_timeout_is_bounded_and_never_fabricates_response(monkeypatch):
    module = probe()
    monkeypatch.setattr(module.rclpy, "spin_until_future_complete", Mock())
    node = Mock()
    client = node.create_client.return_value
    client.call_async.return_value.done.return_value = False
    with pytest.raises(RuntimeError, match="bounded read unavailable"):
        module.query(node, object, "/read", object())
    assert client.call_async.call_count == 3
    assert client.remove_pending_request.call_count == 3


def test_read_discovery_has_no_call_when_service_absent():
    module = probe()
    node = Mock()
    client = node.create_client.return_value
    client.wait_for_service.return_value = False
    with pytest.raises(RuntimeError, match="bounded read unavailable"):
        module.query(node, object, "/read", object())
    assert client.wait_for_service.call_count == 3
    client.call_async.assert_not_called()
