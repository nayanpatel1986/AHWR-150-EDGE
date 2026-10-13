'use strict';
// Canonical Energistics URIs (ETP v1.2 specification, appendix 25.3):
//   dataspace    eml:///                       (default dataspace)
//                eml:///dataspace('{path}')
//   data object  eml:///[dataspace('{path}')/]{type}({uuid})
//                eml:///[dataspace('{path}')/]{type}(uuid={uuid},version='{version}')
// {type} is a qualified type such as witsml21.Channel or eml23.PropertyKind.
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const TYPE = '(?:witsml|resqml|prodml|eml|custom)[1-9]\\d\\.\\w+';
const DATASPACE = "dataspace\\('((?:[^']|'')*)'\\)";
const DATASPACE_RE = new RegExp(`^eml:///(?:${DATASPACE})?$`);
const OBJECT_RE = new RegExp(`^eml:///(?:${DATASPACE}/)?(${TYPE})\\((?:(${UUID})|uuid=(${UUID}),version='((?:[^']|'')*)')\\)$`);

/** Parse a canonical URI: { kind: 'dataspace'|'object', dataspace, type, uuid, version } or null. */
function parse(uri) {
    const s = String(uri || '');
    let m = DATASPACE_RE.exec(s);
    if (m) return { kind: 'dataspace', dataspace: m[1] ? m[1].replace(/''/g, "'") : '' };
    m = OBJECT_RE.exec(s);
    if (m) {
        return {
            kind: 'object', dataspace: m[1] ? m[1].replace(/''/g, "'") : '', type: m[2],
            uuid: (m[3] || m[4]).toLowerCase(), version: m[5] ? m[5].replace(/''/g, "'") : null,
        };
    }
    return null;
}

const dataspacePrefix = (ds) => (ds ? `eml:///dataspace('${String(ds).replace(/'/g, "''")}')` : 'eml://');
/** Canonical data object URI in the default dataspace (or `dataspace`). */
const object = (type, uuid, dataspace = '') => `${dataspacePrefix(dataspace)}/${type}(${String(uuid).toLowerCase()})`;
const dataspace = (ds = '') => (ds ? dataspacePrefix(ds) : 'eml:///');

module.exports = { parse, object, dataspace };
