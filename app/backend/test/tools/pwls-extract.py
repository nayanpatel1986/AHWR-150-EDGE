# Build lib/propertyKinds.json: the Energistics PWLS property kinds the edge uses
# (uuid, title, quantity class, parent), with every ancestor up to the root, taken
# from the official PropertyKindDictionary (Energistics common v2.3 ancillary).
#   python pwls-extract.py <PropertyKindDictionary_v2.3.xml> <out.json>
import json, sys, xml.etree.ElementTree as ET

USED = [
    'hook load', 'weight on bit', 'block height', 'measured depth', 'bit depth', 'penetration rate',
    'rotary speed', 'motor speed', 'angular velocity', 'surface torque', 'makeup torque', 'torque',
    'standpipe pressure', 'differential pressure', 'wellhead pressure', 'engine oil pressure', 'pressure',
    'stroke rate', 'frequency', 'mud flow in', 'mud flow out', 'mud flowrate', 'flowrate',
    'mud tank volume', 'volume', 'engine oil temperature', 'coolant temperature', 'temperature',
    'operating time', 'time', 'load', 'force', 'mass', 'length', 'velocity', 'power',
    'electric potential', 'electric current', 'fraction', 'flag', 'status', 'count', 'indicator', 'unknown',
]
NS = {'eml': 'http://www.energistics.org/energyml/data/commonv2'}
root = ET.parse(sys.argv[1]).getroot()
kinds = {}
for pk in root.findall('eml:PropertyKind', NS):
    kinds[pk.findtext('eml:Citation/eml:Title', namespaces=NS)] = {
        'uuid': pk.get('uuid'),
        'title': pk.findtext('eml:Citation/eml:Title', namespaces=NS),
        'quantityClass': pk.findtext('eml:QuantityClass', namespaces=NS),
        'isAbstract': pk.findtext('eml:IsAbstract', namespaces=NS) == 'true',
        'parent': {'uuid': pk.findtext('eml:Parent/eml:Uuid', namespaces=NS),
                   'title': pk.findtext('eml:Parent/eml:Title', namespaces=NS)},
    }
out, todo = {}, list(USED)
while todo:
    t = todo.pop()
    if t in out:
        continue
    if t not in kinds:
        sys.exit('not in the dictionary: %s' % t)
    out[t] = kinds[t]
    if kinds[t]['parent']['title'] != t:
        todo.append(kinds[t]['parent']['title'])
dictionary = root.find('eml:Citation', NS)
json.dump({
    'source': 'Energistics PropertyKindDictionary v2.3 (PWLS), uuid %s, last update %s; subset used by AHWR-150 EDGE'
              % (root.get('uuid'), dictionary.findtext('eml:LastUpdate', namespaces=NS)),
    'dictionaryUuid': root.get('uuid'),
    'kinds': dict(sorted(out.items())),
}, open(sys.argv[2], 'w'), indent=1)
print(len(out), 'property kinds (', len(USED), 'used + ancestors )')
