# ETP v1.2 conformance check for the edge producer (test tool, not shipped).
# Runs an ETP v1.2 server in the ChannelStreaming CONSUMER role on :9000 and
# prints a RESULT line listing any spec violations. Decodes with fastavro and
# the official v1.2 schemas from etptypes (independent of the backend codec).
#   pip install etptypes==1.2.0 fastavro websockets && python etp12-consumer.py
# Point the edge at it: ETP_ENABLED=true ETP_URL=ws://<host>:9000 ALLOW_INSECURE_TRANSPORT=true
import asyncio, io, json, time, uuid, importlib
import fastavro, websockets

def schema(mod):
    return fastavro.parse_schema(json.loads(importlib.import_module('etptypes.energistics.etp.v12.' + mod).avro_schema))

HDR = schema('datatypes.message_header')
S = {
    (0, 1): ('RequestSession', schema('protocol.core.request_session')),
    (0, 2): ('OpenSession', schema('protocol.core.open_session')),
    (0, 5): ('CloseSession', schema('protocol.core.close_session')),
    (0, 8): ('Ping', schema('protocol.core.ping')),
    (0, 9): ('Pong', schema('protocol.core.pong')),
    (0, 1000): ('ProtocolException', schema('protocol.core.protocol_exception')),
    (1, 1): ('ChannelMetadata', schema('protocol.channel_streaming.channel_metadata')),
    (1, 2): ('ChannelData', schema('protocol.channel_streaming.channel_data')),
    (1, 3): ('StartStreaming', schema('protocol.channel_streaming.start_streaming')),
    (1, 4): ('StopStreaming', schema('protocol.channel_streaming.stop_streaming')),
}
NAME = {v[0]: k for k, v in S.items()}

def enc(name, body, mid, corr=0):
    p, t = NAME[name]
    b = io.BytesIO()
    fastavro.schemaless_writer(b, HDR, {'protocol': p, 'messageType': t, 'correlationId': corr, 'messageId': mid, 'messageFlags': 0x02})
    fastavro.schemaless_writer(b, S[(p, t)][1], body)
    return b.getvalue()

def dec(buf):
    b = io.BytesIO(buf)
    h = fastavro.schemaless_reader(b, HDR)
    name, sch = S[(h['protocol'], h['messageType'])]
    return h, name, fastavro.schemaless_reader(b, sch)

problems, result = [], {}
async def handler(ws):
    req_headers = ws.request.headers
    result['subprotocol'] = ws.subprotocol
    result['etp_encoding'] = req_headers.get('etp-encoding')
    result['authorization'] = 'present' if req_headers.get('Authorization') else 'absent'
    last_id, mid = 0, -1
    def nxt():
        nonlocal mid
        mid += 2
        return mid
    announced, data_frames, points, seen_points = set(), 0, 0, set()
    started = stopped = False
    stop_at = None
    ping_id = None
    t_end = time.time() + 25
    async def recv():
        nonlocal last_id
        raw = await asyncio.wait_for(ws.recv(), timeout=10)
        if not isinstance(raw, (bytes, bytearray)): problems.append('text frame')
        h, name, body = dec(raw)
        if h['messageId'] <= last_id or h['messageId'] % 2 != 0: problems.append(f'bad client messageId {h["messageId"]}')
        last_id = h['messageId']
        if not h['messageFlags'] & 0x02: problems.append(f'FIN missing on {name}')
        return h, name, body
    h, name, body = await recv()
    if name != 'RequestSession': problems.append(f'first message {name}')
    result['requestedProtocols'] = [(p['protocol'], p['role'], p['protocolVersion']) for p in body['requestedProtocols']]
    result['applicationName'] = body['applicationName']
    await ws.send(enc('OpenSession', {
        'applicationName': 'test-consumer', 'applicationVersion': '1', 'serverInstanceId': uuid.uuid4().bytes,
        'supportedProtocols': [{'protocol': 1, 'protocolVersion': {'major': 1, 'minor': 2, 'revision': 0, 'patch': 0}, 'role': 'consumer', 'protocolCapabilities': {}}],
        'supportedDataObjects': [{'qualifiedType': 'witsml21.Channel', 'dataObjectCapabilities': {}}],
        'supportedCompression': '', 'supportedFormats': ['xml'], 'currentDateTime': int(time.time() * 1e6),
        'earliestRetainedChangeTime': 0, 'sessionId': uuid.uuid4().bytes, 'endpointCapabilities': {}}, nxt(), h['messageId']))
    # Spec: the producer must not send data before StartStreaming.
    try:
        h, name, body = await asyncio.wait_for(recv(), timeout=3)
        problems.append(f'{name} received before StartStreaming')
    except asyncio.TimeoutError:
        pass
    await ws.send(enc('StartStreaming', {}, nxt())); started = True
    while time.time() < t_end:
        try:
            h, name, body = await recv()
        except asyncio.TimeoutError:
            if stopped: break
            problems.append('no message for 10 s'); break
        if name == 'ChannelMetadata':
            for c in body['channels']:
                announced.add(c['id'])
                result.setdefault('sample_channel', {k: c[k] for k in ('uri', 'id', 'channelName', 'dataKind', 'uom', 'status')})
                if c['indexes'][0]['indexKind'] != 'DateTime': problems.append('index kind')
        elif name == 'ChannelData':
            if stopped and time.time() - stop_at > 2: problems.append('ChannelData after StopStreaming')
            data_frames += 1
            for d in body['data']:
                if d['channelId'] not in announced: problems.append(f'data for unannounced channel {d["channelId"]}')
                t = d['indexes'][0]['item']
                if not isinstance(t, int) or abs(t / 1e6 - time.time()) > 600: problems.append(f'bad time index {t}')
                key = (d['channelId'], t)
                if key in seen_points: problems.append('duplicate sample'); break
                seen_points.add(key)
                points += 1
            if data_frames == 3 and ping_id is None:
                ping_id = nxt(); await ws.send(enc('Ping', {'currentDateTime': int(time.time() * 1e6)}, ping_id))
            if data_frames == 6 and not stopped:
                await ws.send(enc('StopStreaming', {}, nxt())); stopped = True; stop_at = time.time()
        elif name == 'Pong':
            result['pong_correlates'] = h['correlationId'] == ping_id
        elif name == 'ProtocolException':
            problems.append(f'ProtocolException from producer: {body}')
    result.update({'channels_announced': len(announced), 'data_frames': data_frames, 'points': points,
                   'problems': sorted(set(problems))})
    print('RESULT ' + json.dumps(result), flush=True)
    await ws.close()

async def main():
    async with websockets.serve(handler, '0.0.0.0', 9000, subprotocols=['etp12.energistics.org']):
        print('ETP v1.2 test consumer listening on :9000', flush=True)
        await asyncio.Future()
asyncio.run(main())
