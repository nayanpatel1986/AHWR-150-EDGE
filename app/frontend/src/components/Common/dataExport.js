const encoder = new TextEncoder();

const GRAPH_COLORS = [
    '#38bdf8', '#fbbf24', '#4ade80', '#f472b6', '#a78bfa',
    '#fb7185', '#22d3ee', '#f97316', '#84cc16', '#e879f9'
];

const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let value = n;
        for (let bit = 0; bit < 8; bit += 1) {
            value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
        }
        table[n] = value >>> 0;
    }
    return table;
})();

const crc32 = (bytes) => {
    let crc = 0xffffffff;
    bytes.forEach(byte => {
        crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    });
    return (crc ^ 0xffffffff) >>> 0;
};

const writeU16 = (view, offset, value) => view.setUint16(offset, value, true);
const writeU32 = (view, offset, value) => view.setUint32(offset, value, true);

const concatBytes = (parts) => {
    const size = parts.reduce((total, part) => total + part.length, 0);
    const result = new Uint8Array(size);
    let offset = 0;
    parts.forEach(part => {
        result.set(part, offset);
        offset += part.length;
    });
    return result;
};

const createZip = (files) => {
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const localParts = [];
    const centralParts = [];
    let localOffset = 0;

    files.forEach(file => {
        const name = encoder.encode(file.name);
        const content = typeof file.content === 'string' ? encoder.encode(file.content) : file.content;
        const checksum = crc32(content);

        const localHeader = new Uint8Array(30);
        const localView = new DataView(localHeader.buffer);
        writeU32(localView, 0, 0x04034b50);
        writeU16(localView, 4, 20);
        writeU16(localView, 6, 0x0800);
        writeU16(localView, 8, 0);
        writeU16(localView, 10, dosTime);
        writeU16(localView, 12, dosDate);
        writeU32(localView, 14, checksum);
        writeU32(localView, 18, content.length);
        writeU32(localView, 22, content.length);
        writeU16(localView, 26, name.length);
        writeU16(localView, 28, 0);
        localParts.push(localHeader, name, content);

        const centralHeader = new Uint8Array(46);
        const centralView = new DataView(centralHeader.buffer);
        writeU32(centralView, 0, 0x02014b50);
        writeU16(centralView, 4, 20);
        writeU16(centralView, 6, 20);
        writeU16(centralView, 8, 0x0800);
        writeU16(centralView, 10, 0);
        writeU16(centralView, 12, dosTime);
        writeU16(centralView, 14, dosDate);
        writeU32(centralView, 16, checksum);
        writeU32(centralView, 20, content.length);
        writeU32(centralView, 24, content.length);
        writeU16(centralView, 28, name.length);
        writeU16(centralView, 30, 0);
        writeU16(centralView, 32, 0);
        writeU16(centralView, 34, 0);
        writeU16(centralView, 36, 0);
        writeU32(centralView, 38, 0);
        writeU32(centralView, 42, localOffset);
        centralParts.push(centralHeader, name);

        localOffset += localHeader.length + name.length + content.length;
    });

    const localData = concatBytes(localParts);
    const centralData = concatBytes(centralParts);
    const endRecord = new Uint8Array(22);
    const endView = new DataView(endRecord.buffer);
    writeU32(endView, 0, 0x06054b50);
    writeU16(endView, 4, 0);
    writeU16(endView, 6, 0);
    writeU16(endView, 8, files.length);
    writeU16(endView, 10, files.length);
    writeU32(endView, 12, centralData.length);
    writeU32(endView, 16, localData.length);
    writeU16(endView, 20, 0);

    return concatBytes([localData, centralData, endRecord]);
};

const xmlEscape = (value) => String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const columnName = (index) => {
    let result = '';
    let value = index + 1;
    while (value > 0) {
        const remainder = (value - 1) % 26;
        result = String.fromCharCode(65 + remainder) + result;
        value = Math.floor((value - 1) / 26);
    }
    return result;
};

const worksheetCell = (value, column, row, style = '') => {
    const reference = `${columnName(column)}${row}`;
    if (value === null || value === undefined || value === '') {
        return `<c r="${reference}"${style}/>`;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return `<c r="${reference}"${style}><v>${value}</v></c>`;
    }
    return `<c r="${reference}" t="inlineStr"${style}><is><t>${xmlEscape(value)}</t></is></c>`;
};

const createXlsx = (rows, parameters) => {
    const headers = [
        'Timestamp',
        ...parameters.map(parameter => `${parameter.label}${parameter.unit ? ` (${parameter.unit})` : ''}`)
    ];
    const dataRows = rows.map(row => [
        row.timestamp ? new Date(row.timestamp).toISOString() : (row.name || ''),
        ...parameters.map(parameter => {
            const numeric = Number(row[parameter.key]);
            return Number.isFinite(numeric) ? numeric : '';
        })
    ]);
    const allRows = [headers, ...dataRows];
    const lastCell = `${columnName(headers.length - 1)}${Math.max(1, allRows.length)}`;
    const rowXml = allRows.map((row, rowIndex) => {
        const cells = row.map((value, columnIndex) => (
            worksheetCell(value, columnIndex, rowIndex + 1, rowIndex === 0 ? ' s="1"' : '')
        )).join('');
        return `<row r="${rowIndex + 1}">${cells}</row>`;
    }).join('');
    const columnXml = headers.map((_, index) => (
        `<col min="${index + 1}" max="${index + 1}" width="${index === 0 ? 24 : 18}" customWidth="1"/>`
    )).join('');

    const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:${lastCell}"/>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${columnXml}</cols>
<sheetData>${rowXml}</sheetData>
<autoFilter ref="A1:${columnName(headers.length - 1)}1"/>
</worksheet>`;

    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0F766E"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

    return createZip([
        {
            name: '[Content_Types].xml',
            content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`
        },
        {
            name: '_rels/.rels',
            content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
        },
        {
            name: 'xl/workbook.xml',
            content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Export Data" sheetId="1" r:id="rId1"/></sheets>
</workbook>`
        },
        {
            name: 'xl/_rels/workbook.xml.rels',
            content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
        },
        { name: 'xl/worksheets/sheet1.xml', content: worksheet },
        { name: 'xl/styles.xml', content: styles }
    ]);
};

const downloadBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
};

const escapeCsv = (value) => {
    const text = value == null ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export const downloadCsv = (rows, parameters, filename) => {
    const headers = [
        'Timestamp',
        ...parameters.map(parameter => `${parameter.label}${parameter.unit ? ` (${parameter.unit})` : ''}`)
    ];
    const dataRows = rows.map(row => [
        row.timestamp ? new Date(row.timestamp).toISOString() : (row.name || ''),
        ...parameters.map(parameter => {
            const numeric = Number(row[parameter.key]);
            if (!Number.isFinite(numeric)) return '';
            return numeric.toFixed(Number.isInteger(parameter.precision) ? parameter.precision : 2);
        })
    ]);
    const csv = [headers, ...dataRows].map(row => row.map(escapeCsv).join(',')).join('\n');
    downloadBlob(new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' }), filename);
};

export const downloadXlsx = (rows, parameters, filename) => {
    const workbook = createXlsx(rows, parameters);
    downloadBlob(
        new Blob([workbook], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
        filename
    );
};

const canvasBlob = (canvas) => new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error('Unable to create graph image.'));
    }, 'image/png');
});

export const downloadGraphPng = async (rows, parameters, filename, title, rangeLabel) => {
    const sortedRows = [...rows]
        .filter(row => Number.isFinite(Number(row.timestamp)))
        .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
    const series = parameters.map((parameter, index) => {
        const points = sortedRows
            .map(row => ({ x: Number(row.timestamp), y: Number(row[parameter.key]) }))
            .filter(point => Number.isFinite(point.y));
        if (points.length === 0) return null;
        const values = points.map(point => point.y);
        return {
            ...parameter,
            color: GRAPH_COLORS[index % GRAPH_COLORS.length],
            points,
            min: Math.min(...values),
            max: Math.max(...values)
        };
    }).filter(Boolean);

    if (series.length === 0) throw new Error('The selected parameters have no numeric data in this range.');

    const width = 1600;
    const legendColumns = 3;
    const legendRows = Math.ceil(series.length / legendColumns);
    const height = Math.max(900, 760 + legendRows * 34);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    const plot = { left: 105, top: 150, right: width - 70, bottom: 680 };
    const firstTime = sortedRows[0].timestamp;
    const lastTime = sortedRows[sortedRows.length - 1].timestamp;
    const timeSpan = Math.max(1, lastTime - firstTime);

    context.fillStyle = '#0f172a';
    context.fillRect(0, 0, width, height);
    context.fillStyle = '#f8fafc';
    context.font = 'bold 34px Arial';
    context.fillText(title, 70, 60);
    context.fillStyle = '#94a3b8';
    context.font = '20px Arial';
    context.fillText(`${rangeLabel} | ${sortedRows.length} data points`, 70, 98);

    context.strokeStyle = '#334155';
    context.lineWidth = 1;
    for (let index = 0; index <= 5; index += 1) {
        const y = plot.top + ((plot.bottom - plot.top) * index / 5);
        context.beginPath();
        context.moveTo(plot.left, y);
        context.lineTo(plot.right, y);
        context.stroke();
    }
    for (let index = 0; index <= 6; index += 1) {
        const x = plot.left + ((plot.right - plot.left) * index / 6);
        context.beginPath();
        context.moveTo(x, plot.top);
        context.lineTo(x, plot.bottom);
        context.stroke();
        const timestamp = firstTime + (timeSpan * index / 6);
        context.fillStyle = '#94a3b8';
        context.font = '16px Arial';
        context.textAlign = index === 0 ? 'left' : (index === 6 ? 'right' : 'center');
        context.fillText(new Date(timestamp).toLocaleString(), x, plot.bottom + 34);
    }

    series.forEach(item => {
        const valueSpan = Math.max(1e-9, item.max - item.min);
        context.strokeStyle = item.color;
        context.lineWidth = 2.5;
        context.beginPath();
        item.points.forEach((point, index) => {
            const x = plot.left + ((point.x - firstTime) / timeSpan) * (plot.right - plot.left);
            const normalized = item.max === item.min ? 0.5 : (point.y - item.min) / valueSpan;
            const y = plot.bottom - normalized * (plot.bottom - plot.top);
            if (index === 0) context.moveTo(x, y);
            else context.lineTo(x, y);
        });
        context.stroke();
    });

    context.textAlign = 'left';
    context.font = '17px Arial';
    series.forEach((item, index) => {
        const column = index % legendColumns;
        const row = Math.floor(index / legendColumns);
        const x = 70 + column * 505;
        const y = 755 + row * 34;
        context.fillStyle = item.color;
        context.fillRect(x, y - 14, 22, 5);
        context.fillStyle = '#e2e8f0';
        const unit = item.unit ? ` ${item.unit}` : '';
        context.fillText(
            `${item.label}: ${item.min.toFixed(2)} to ${item.max.toFixed(2)}${unit}`,
            x + 34,
            y
        );
    });
    context.fillStyle = '#64748b';
    context.font = '15px Arial';
    context.fillText('Each parameter line is scaled to its own minimum and maximum.', 70, height - 28);

    downloadBlob(await canvasBlob(canvas), filename);
};
