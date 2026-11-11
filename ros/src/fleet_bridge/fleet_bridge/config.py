"""秘密値を例外へ含めない起動設定検証。"""

from dataclasses import dataclass, field
import os
from pathlib import Path
import re
import ssl
import stat
import uuid

from fleet_reference.model import namespace


class ConfigurationError(Exception):
    pass


def integer(env, name, default, minimum, maximum):
    value = env.get(name, str(default))
    if (len(value) > 10 or not re.fullmatch(r"[0-9]+", value)
            or not minimum <= int(value) <= maximum):
        raise ConfigurationError(name)
    return int(value)


@dataclass(frozen=True)
class Config:
    device_id: str
    namespace: str
    host: str = field(repr=False)
    port: int
    client_id: str
    state_dir: Path = field(repr=False)
    tls: ssl.SSLContext | None = field(repr=False)
    queue_limit: int = 100
    record_limit: int = 10000
    byte_limit: int = 32 * 1024 * 1024
    reconnect_min: int = 1
    reconnect_max: int = 8
    test_fault: str | None = None
    test_fault_command: str = ""


def load_config(env=None):
    env = os.environ if env is None else env
    device = env.get("BRIDGE_DEVICE_ID", "")
    try:
        ns = namespace(device)
    except ValueError:
        raise ConfigurationError("BRIDGE_DEVICE_ID") from None
    if env.get("BRIDGE_ROS_NAMESPACE", ns) != ns:
        raise ConfigurationError("BRIDGE_ROS_NAMESPACE")
    integer(env, "ROS_DOMAIN_ID", 42, 0, 101)
    discovery = env.get("ROS_AUTOMATIC_DISCOVERY_RANGE", "LOCALHOST")
    test_udp = (env.get("BRIDGE_INTEGRATION") == "true" and discovery == "SYSTEM_DEFAULT"
                and env.get("FASTRTPS_DEFAULT_PROFILES_FILE")
                == "/workspace/config/dds-udp-test.xml")
    if ((discovery != "LOCALHOST" and not test_udp)
            or env.get("ROS_STATIC_PEERS", "")
            or env.get("RMW_IMPLEMENTATION", "rmw_fastrtps_cpp") != "rmw_fastrtps_cpp"):
        raise ConfigurationError("ROS_DISCOVERY")
    transport = env.get("MQTT_TRANSPORT", "local")
    tls = None
    if transport == "local":
        host = env.get("MQTT_HOST", "127.0.0.1")
        port = integer(env, "MQTT_PORT", 1883, 1, 65535)
        client_id = "bridge-" + device
        if any(env.get(key) for key in (
            "AWS_IOT_ENDPOINT", "AWS_IOT_ROOT_CA_PATH", "AWS_IOT_DEVICE_CREDENTIALS_DIR",
        )):
            raise ConfigurationError("MQTT_TRANSPORT")
    elif transport == "aws-iot":
        host = env.get("AWS_IOT_ENDPOINT", "")
        port, client_id = 8883, device
        if env.get("MQTT_HOST") or env.get("MQTT_PORT"):
            raise ConfigurationError("MQTT_TRANSPORT")
        try:
            ca = Path(env["AWS_IOT_ROOT_CA_PATH"])
            credentials = Path(env["AWS_IOT_DEVICE_CREDENTIALS_DIR"]) / device
            cert, key = credentials / "device.pem.crt", credentials / "private.pem.key"
            for path in (ca, cert, key):
                if not path.is_absolute() or not path.is_file() or path.stat().st_size == 0:
                    raise ValueError()
            if stat.S_IMODE(key.stat().st_mode) & 0o077:
                raise ValueError()
            tls = ssl.create_default_context(cafile=str(ca))
            tls.minimum_version = ssl.TLSVersion.TLSv1_2
            tls.load_cert_chain(str(cert), str(key))
        except (KeyError, ValueError, OSError, ssl.SSLError):
            raise ConfigurationError("AWS_IOT_CREDENTIALS") from None
    else:
        raise ConfigurationError("MQTT_TRANSPORT")
    if (not re.fullmatch(r"[A-Za-z0-9.-]{1,253}", host)
            or any(not part or len(part) > 63 or part.startswith("-") or part.endswith("-")
                   for part in host.split("."))):
        raise ConfigurationError("MQTT_ENDPOINT")
    directory = Path(env.get("BRIDGE_STATE_DIR", "/data/fleet"))
    if not directory.is_absolute() or directory.is_symlink():
        raise ConfigurationError("BRIDGE_STATE_DIR")
    low = integer(env, "BRIDGE_RECONNECT_MIN_SEC", 1, 1, 8)
    high = integer(env, "BRIDGE_RECONNECT_MAX_SEC", 8, low, 8)
    fault = env.get("BRIDGE_TEST_FAULT") or None
    fault_command = env.get("BRIDGE_TEST_FAULT_COMMAND_ID", "")
    if fault or fault_command:
        try:
            if (env.get("BRIDGE_INTEGRATION") != "true" or fault not in (
                    "BEFORE_SEND_INTENT", "AFTER_SEND_INTENT", "AFTER_SEND_GOAL", "AFTER_RESULT")
                    or (fault_command and str(uuid.UUID(fault_command, version=4))
                        != fault_command)):
                raise ValueError()
        except ValueError:
            raise ConfigurationError("BRIDGE_TEST_FAULT") from None
    return Config(
        device, ns, host, port, client_id, directory, tls,
        integer(env, "BRIDGE_QUEUE_LIMIT", 100, 1, 100),
        integer(env, "BRIDGE_RECORD_LIMIT", 10000, 1, 10000),
        integer(env, "BRIDGE_BYTE_LIMIT", 33554432, 32768, 33554432), low, high,
        fault, fault_command,
    )
