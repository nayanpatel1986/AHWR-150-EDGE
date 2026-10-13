# Build the ETP v1.2 Avro schema bundle (lib/etp12/schemas.json) from etptypes
# (Geosiris, Apache-2.0), which carries the official Energistics ETP v1.2 Avro
# schemas. Every message of the protocols below is included.
#   python etp12-extract-schemas.py <out.json>
import importlib, importlib.metadata, json, pkgutil, sys

PROTOCOLS = ['core', 'channel_streaming', 'channel_data_frame', 'discovery', 'store',
             'channel_subscribe', 'channel_data_load']
BASE = 'etptypes.energistics.etp.v12'
out = {'source': 'Energistics Transfer Protocol (ETP) v1.2 Avro schemas, extracted from etptypes %s (Geosiris, Apache-2.0)'
       % importlib.metadata.version('etptypes'), 'messages': []}

header = importlib.import_module(BASE + '.datatypes.message_header')
out['messages'].append({'name': 'MessageHeader', 'schema': json.loads(header.avro_schema)})
# Records used outside messages: the .well-known/etp-server-capabilities document.
caps = importlib.import_module(BASE + '.datatypes.server_capabilities')
out['records'] = {'ServerCapabilities': json.loads(caps.avro_schema)}
for proto in PROTOCOLS:
    pkg = importlib.import_module('%s.protocol.%s' % (BASE, proto))
    for info in sorted(pkgutil.iter_modules(pkg.__path__), key=lambda i: i.name):
        m = importlib.import_module('%s.protocol.%s.%s' % (BASE, proto, info.name))
        if not hasattr(m, 'avro_schema'):
            continue
        schema = json.loads(m.avro_schema)
        if 'protocol' not in schema:
            continue
        out['messages'].append({'name': schema['name'], 'schema': schema, 'protocol': int(schema['protocol']),
                                'messageType': int(schema['messageType']), 'senderRole': schema.get('senderRole')})
json.dump(out, open(sys.argv[1], 'w'), indent=1)
for e in out['messages']:
    print(e.get('protocol'), e.get('messageType'), e['name'], e.get('senderRole'))
