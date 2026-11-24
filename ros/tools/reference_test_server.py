"""E2Eだけの起動wrapper。通常の参照package・安全判定は変更しない。"""

import threading

from execution_barrier import execution_barrier
from fleet_reference.cli import main
from fleet_reference.nodes import ReferenceAdapter, State


original_execute = ReferenceAdapter.execute
original_check = State.check


def execute(adapter, handle):
    adapter.state._test_execution_handle = handle
    adapter.state._test_execution_thread = threading.get_ident()
    try:
        return original_execute(adapter, handle)
    finally:
        adapter.state._test_execution_handle = None
        adapter.state._test_execution_thread = None


def check(state):
    handle = getattr(state, "_test_execution_handle", None)
    if (handle is not None
            and getattr(state, "_test_execution_thread", None) == threading.get_ident()):
        # 元executeが実行回数・開始時刻を記録した後、制約検査/終端より前。
        execution_barrier(state, handle)
    return original_check(state)


ReferenceAdapter.execute = execute
State.check = check

if __name__ == "__main__":
    main()
