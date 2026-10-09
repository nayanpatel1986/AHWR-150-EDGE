import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

from asyncua import Client, ua
from influxdb_client import InfluxDBClient, Point
from influxdb_client.client.write_api import SYNCHRONOUS

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("versamax-bop")

OPCUA_URL = os.getenv("KEPWARE_OPCUA_URL", "opc.tcp://host.docker.internal:49320")
USERNAME = os.getenv("KEPWARE_OPCUA_USERNAME", "")
PASSWORD = os.getenv("KEPWARE_OPCUA_PASSWORD", "")
SECURITY_POLICY = os.getenv("KEPWARE_SECURITY_POLICY", "")
SECURITY_MODE = os.getenv("KEPWARE_SECURITY_MODE", "")
CERT_PATH = os.getenv("KEPWARE_CERT_PATH", "")
PRIVATE_KEY_PATH = os.getenv("KEPWARE_PRIVATE_KEY_PATH", "")
CONFIG_PATH = Path(os.getenv("BOP_CONFIG_PATH", "/config/bop_config.json"))
INFLUX_URL = os.getenv("INFLUX_URL", "http://influxdb:8086")
INFLUX_TOKEN = os.environ["INFLUX_TOKEN"]
INFLUX_ORG = os.getenv("INFLUX_ORG", "romii_org")
INFLUX_BUCKET = os.getenv("INFLUX_BUCKET", "romii_bucket")
RECONNECT_INITIAL = float(os.getenv("BOP_RECONNECT_INITIAL_SECONDS", "2"))
RECONNECT_MAX = float(os.getenv("BOP_RECONNECT_MAX_SECONDS", "60"))


def load_config():
    try:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError) as exc:
        log.warning("BOP configuration unavailable: %s", exc)
        return {"enabled": False, "tags": []}
    return config


def configured_tags(config):
    return [tag for tag in config.get("tags", []) if tag.get("enabled", True) and tag.get("nodeId")]


def quality_name(status):
    if status == ua.StatusCode(ua.StatusCodes.Good):
        return "good"
    if status.is_uncertain:
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


async def collect_once(write_api):
    config = load_config()
    if not config.get("enabled", True):
        log.info("VersaMax BOP collector disabled in administration settings")
        await asyncio.sleep(10)
        return False

    client = await make_client(config)
    try:
        await client.connect()
        log.info("VersaMax OPC UA connected: %s", OPCUA_URL)
        tags = configured_tags(config)
        if not tags:
            log.warning("OPC UA connected, but no BOP Node IDs configured; enter confirmed Kepware Node IDs in Settings > Administration")
            return True
        nodes = [(tag, client.get_node(tag["nodeId"])) for tag in tags]
        point = Point("bop").tag("source", "versamax").tag("quality", "good")
        timestamp = datetime.now(timezone.utc)
        good_values = 0
        for tag, node in nodes:
            try:
                value = await node.read_value()
                status = await node.read_data_value()
                quality = quality_name(status.StatusCode)
                if quality != "good":
                    log.warning("VersaMax tag quality %s: %s", quality, tag["name"])
                    continue
                if isinstance(value, (bool, int, float)):
                    point = point.field(tag["field"], value)
                    good_values += 1
                else:
                    log.warning("VersaMax tag is not numeric/bool: %s", tag["name"])
            except Exception as exc:
                log.warning("VersaMax tag read failed: %s (%s)", tag["name"], exc)
        if good_values:
            write_api.write(bucket=INFLUX_BUCKET, org=INFLUX_ORG, record=point.time(timestamp))
            log.info("VersaMax data written to InfluxDB (%d tags)", good_values)
        else:
            log.warning("VersaMax connected but no good BOP tag values were read")
        return True
    finally:
        try:
            await client.disconnect()
        except Exception:
            pass


async def main():
    backoff = RECONNECT_INITIAL
    with InfluxDBClient(url=INFLUX_URL, token=INFLUX_TOKEN, org=INFLUX_ORG) as influx:
        write_api = influx.write_api(write_options=SYNCHRONOUS)
        while True:
            try:
                connected = await collect_once(write_api)
                backoff = RECONNECT_INITIAL if connected else min(backoff * 2, RECONNECT_MAX)
            except Exception as exc:
                log.error("VersaMax OPC UA disconnected: %s", exc)
                log.info("VersaMax reconnecting in %.1f seconds...", backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, RECONNECT_MAX)
            else:
                await asyncio.sleep(1)


if __name__ == "__main__":
    asyncio.run(main())
