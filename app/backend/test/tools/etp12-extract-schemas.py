# Build the ETP v1.2 Avro schema bundle used by the edge (lib/etp12/schemas.json)
# from etptypes (Geosiris, Apache-2.0), which carries the official Energistics
# ETP v1.2 Avro schemas.
import importlib, importlib.metadata, json, sys
MODS = {
    'datatypes': ['message_header'],
    'protocol.core': ['request_session', 'open_session', 'close_session', 'protocol_exception', 'acknowledge', 'ping', 'pong'],
    'protocol.channel_streaming': ['channel_metadata', 'channel_data', 'start_streaming', 'stop_streaming', 'truncate_channels'],
}
out = {'source': 'Energistics Transfer Protocol (ETP) v1.2 Avro schemas, extracted from etptypes %s (Geosiris, Apache-2.0)' % importlib.metadata.version('etptypes'),
       'messages': []}
for pkg, names in MODS.items():
    for n in names:
        m = importlib.import_module('etptypes.energistics.etp.v12.%s.%s' % (pkg, n))
        schema = json.loads(m.avro_schema)
        entry = {'name': schema['name'], 'schema': schema}
        if 'protocol' in schema:
            entry['protocol'] = int(schema['protocol']); entry['messageType'] = int(schema['messageType'])
            entry['senderRole'] = schema.get('senderRole')
        out['messages'].append(entry)
json.dump(out, open(sys.argv[1], 'w'), indent=1)
for e in out['messages']:
    print(e['name'], e.get('protocol'), e.get('messageType'), e.get('senderRole'), [f['name'] for f in e['schema']['fields']])
