import asyncio
import json
import logging
import os
import time
import urllib.request
from pathlib import Path

from asyncua import Client, ua

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("versamax-bop")
logging.getLogger("asyncua").setLevel(logging.WARNING)  # it logs every Read at INFO

OPCUA_URL = os.getenv("KEPWARE_OPCUA_URL", "opc.tcp://host.docker.internal:49320")
USERNAME = os.getenv("KEPWARE_OPCUA_USERNAME", "")
PASSWORD = os.getenv("KEPWARE_OPCUA_PASSWORD", "")
SECURITY_POLICY = os.getenv("KEPWARE_SECURITY_POLICY", "")
SECURITY_MODE = os.getenv("KEPWARE_SECURITY_MODE", "")
CERT_PATH = os.getenv("KEPWARE_CERT_PATH", "")
PRIVATE_KEY_PATH = os.getenv("KEPWARE_PRIVATE_KEY_PATH", "")
CONFIG_PATH = Path(os.getenv("BOP_CONFIG_PATH", "/config/bop_config.json"))
# Readings go to Telegraf's loopback listener (inputs.influxdb_v2_listener),
# which maps them to CMF telemetry rows (bop.<field>) like the PLC data. The
# collector holds no database credentials.
TELEGRAF_LISTENER_URL = os.getenv("TELEGRAF_LISTENER_URL", "http://127.0.0.1:8186").rstrip("/")
RECONNECT_INITIAL = float(os.getenv("BOP_RECONNECT_INITIAL_SECONDS", "2"))
RECONNECT_MAX = float(os.getenv("BOP_RECONNECT_MAX_SECONDS", "60"))


def load_config():
    try:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8-sig"))  # tolerate a BOM
    except (FileNotFoundError, json.JSONDecodeError) as exc:
        log.warning("BOP configuration unavailable: %s", exc)
        return {"enabled": False, "tags": []}
    return config


def _escape_key(value):
    return str(value).replace("\\", "\\\\").replace(",", "\\,").replace("=", "\\=").replace(" ", "\\ ")


def line_protocol(fields, timestamp_ns):
    """One 'bop' line: booleans as true/false, numbers as floats."""
    parts = []
    for key, value in fields.items():
        if isinstance(value, bool):
            parts.append(f"{_escape_key(key)}={'true' if value else 'false'}")
        else:
            parts.append(f"{_escape_key(key)}={float(value)!r}")
    return f"bop,source=versamax,quality=good {','.join(parts)} {timestamp_ns}"


def write_line(line):
    req = urllib.request.Request(
        f"{TELEGRAF_LISTENER_URL}/api/v2/write?bucket=ahwr&org=ahwr&precision=ns",
        data=line.encode("utf-8"),
        headers={"Content-Type": "text/plain; charset=utf-8"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        if resp.status >= 300:
            raise RuntimeError(f"Telegraf listener returned HTTP {resp.status}")


def configured_tags(config):
    return [tag for tag in config.get("tags", []) if tag.get("enabled", True) and tag.get("nodeId")]


def quality_name(status):
    if status.is_good():
        return "good"
    if status.is_uncertain():
        return "uncertain"
    return "bad"


async def make_client(config):
    client = Client(url=OPCUA_URL)
    if USERNAME:
        client.set_user(USERNAME)
        client.set_password(PASSWORD)
    security_policy = SECURITY_POLICY or config.get("securityPolicy", "")
    security_mode = SECURITY_MODE or config.get("securityMode", "")
    if security_policy not in ("", "None") or security_mode not in ("", "None"):
        if not (security_policy and security_mode and CERT_PATH and PRIVATE_KEY_PATH):
            raise RuntimeError("OPC UA security requires policy, mode, KEPWARE_CERT_PATH and KEPWARE_PRIVATE_KEY_PATH")
        security = f"{security_policy},{security_mode},{CERT_PATH},{PRIVATE_KEY_PATH}"
        await client.set_security_string(security)
    return client


def config_stamp():
    try:
        return CONFIG_PATH.stat().st_mtime_ns
    except OSError:
        return None


async def run_session(config):
    """One OPC UA session, kept open: read every configured node once a second
    in a single Read request, until the session fails or bop_config.json
    changes. Returns True when it should reconnect at once (config change)."""
    stamp = config_stamp()
    client = await make_client(config)
    await client.connect()
    log.info("VersaMax OPC UA connected: %s", OPCUA_URL)
    try:
        tags = configured_tags(config)
        if not tags:
            log.warning("OPC UA connected, but no BOP Node IDs configured; enter confirmed Kepware Node IDs in Settings > Administration")
        nodes = [client.get_node(tag["nodeId"]) for tag in tags]
        while True:
            if config_stamp() != stamp:
                log.info("BOP configuration changed; reconnecting")
                return True
            if nodes:
                data_values = await client.read_attributes(nodes)
                fields = {}
                for tag, dv in zip(tags, data_values):
                    quality = quality_name(dv.StatusCode)
                    value = dv.Value.Value if dv.Value is not None else None
                    if quality != "good":
                        log.warning("VersaMax tag quality %s: %s", quality, tag["name"])
                    elif isinstance(value, (bool, int, float)):
                        fields[tag["field"]] = value
                    else:
                        log.warning("VersaMax tag is not numeric/bool: %s", tag["name"])
                if fields:
                    await asyncio.to_thread(write_line, line_protocol(fields, time.time_ns()))
            else:
                await client.check_connection()
            await asyncio.sleep(1)
    finally:
        try:
            await client.disconnect()
        except Exception:
            pass


async def main():
    backoff = RECONNECT_INITIAL
    while True:
        config = load_config()
        if not config.get("enabled", True):
            log.info("VersaMax BOP collector disabled in administration settings")
            await asyncio.sleep(10)
            continue
        try:
            if await run_session(config):
                backoff = RECONNECT_INITIAL
                continue
        except Exception as exc:
            log.error("VersaMax OPC UA session ended: %s", exc)
        log.info("VersaMax reconnecting in %.1f seconds...", backoff)
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, RECONNECT_MAX)


if __name__ == "__main__":
    asyncio.run(main())
