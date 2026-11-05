"""参照nodeの独立process用entrypoint。"""

import argparse
import json
import signal
import time

import rclpy
from rclpy.executors import MultiThreadedExecutor
from rclpy.signals import SignalHandlerOptions

from .model import load_configs
from .nodes import ReferenceAdapter, ReferenceVehicle, State


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    configs = load_configs(args.config)
    rclpy.init(signal_handler_options=SignalHandlerOptions.NO)
    stopping = False

    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    executor = MultiThreadedExecutor(num_threads=max(4, len(configs) * 2 + 2))
    nodes = []
    try:
        for config in configs:
            state = State(config)
            for node in [ReferenceVehicle(state), ReferenceAdapter(state)]:
                nodes.append(node)
                executor.add_node(node)
            print(json.dumps({"event": "REFERENCE_READY", "deviceId": config.device_id,
                              "serverInstanceId": state.server_id,
                              "configurationId": config.digest}), flush=True)
        while not stopping:
            executor.spin_once(timeout_sec=0.1)
    finally:
        # contextを壊す前に実行threadとpublisher callbackを回収する。
        for node in nodes:
            node.state.stopping = True
            for timer in node.timers:
                timer.cancel()
            executor.remove_node(node)
        # Jazzyのexecutorはshutdown時にguardを先に破棄するため、先に
        # 有限な既存callbackだけをspinして完了させる。新規nodeは追加しない。
        deadline = time.monotonic() + 1.0
        while time.monotonic() < deadline:
            executor.spin_once(timeout_sec=0.05)
        executor.shutdown(timeout_sec=5)
        for node in reversed(nodes):
            node.destroy_node()
        rclpy.try_shutdown()


if __name__ == "__main__":
    main()
