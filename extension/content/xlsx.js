/**
 * XlsxWriter — 의존성 없는 최소 XLSX(OOXML) 작성기
 *
 * - 병합셀(mergeCells) 유지, 머리글 굵게/배경, 숫자 서식(#,##0), 머리글 행 고정, 자동 필터
 * - ZIP은 CompressionStream('deflate-raw') 사용, 미지원 시 STORE로 폴백
 * - globalThis.XlsxWriter.build(sheets, meta) → Promise<Uint8Array>
 *
 * sheets: [{ name, rows: [[string|number]], merges: [{r,c,rs,cs}], headerRows: 1, widths?: number[] }]
 */
(() => {
  'use strict';

  /* ------------------------------------------------------------- utils */

  const XML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => XML_ESCAPE[c]);

  function colName(index) {
    let n = index + 1;
    let name = '';
    while (n > 0) {
      const rem = (n - 1) % 26;
      name = String.fromCharCode(65 + rem) + name;
      n = Math.floor((n - 1) / 26);
    }
    return name;
  }

  function sanitizeSheetName(name, used) {
    let base = String(name || 'Sheet1')
      .replace(/[\\/*?[\]:]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 31) || 'Sheet1';
    let candidate = base;
    let i = 2;
    while (used.has(candidate.toLowerCase())) {
      const suffix = ` (${i})`;
      candidate = base.slice(0, 31 - suffix.length) + suffix;
      i += 1;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  }

  /* ---------------------------------------------------------------- crc */

  const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = -1;
    for (let i = 0; i < bytes.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xff];
    return (c ^ -1) >>> 0;
  }

  /* ---------------------------------------------------------------- zip */

  async function deflateRaw(bytes) {
    if (typeof CompressionStream === 'undefined') return null;
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      const buffer = await new Response(stream).arrayBuffer();
      return new Uint8Array(buffer);
    } catch (e) {
      return null;
    }
  }

  function dosStamp(d = new Date()) {
    const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
    const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
    return { time, date };
  }

  async function zip(entries) {
    const encoder = new TextEncoder();
    const { time, date } = dosStamp();
    const chunks = [];
    const central = [];
    let offset = 0;

    for (const entry of entries) {
      const nameBytes = encoder.encode(entry.name);
      const data = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
      let compressed = await deflateRaw(data);
      let method = 8;
      if (!compressed || compressed.length >= data.length) {
        compressed = data;
        method = 0;
      }
      const crc = crc32(data);

      const local = new Uint8Array(30);
      const dv = new DataView(local.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0x0800, true); // UTF-8
      dv.setUint16(8, method, true);
      dv.setUint16(10, time, true);
      dv.setUint16(12, date, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, compressed.length, true);
      dv.setUint32(22, data.length, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      chunks.push(local, nameBytes, compressed);

      const cd = new Uint8Array(46);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, method, true);
      cv.setUint16(12, time, true);
      cv.setUint16(14, date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, compressed.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      central.push(cd, nameBytes);

      offset += 30 + nameBytes.length + compressed.length;
    }

    let centralSize = 0;
    for (const c of central) centralSize += c.length;
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);

    const total = offset + centralSize + 22;
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of chunks) {
      out.set(c, p);
      p += c.length;
    }
    for (const c of central) {
      out.set(c, p);
      p += c.length;
    }
    out.set(eocd, p);
    return out;
  }

  /* -------------------------------------------------------------- parts */

  const contentTypes = (count) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${Array.from(
  { length: count },
  (_, i) =>
    `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
).join('\n')}
</Types>`;

  const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0"/></numFmts>
<fonts count="2">
<font><sz val="11"/><color theme="1"/><name val="맑은 고딕"/><family val="2"/></font>
<font><b/><sz val="11"/><color theme="1"/><name val="맑은 고딕"/><family val="2"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFEEF2F9"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  function sheetXml(sheet) {
    const rows = sheet.rows || [];
    const headerRows = Math.max(0, Math.min(sheet.headerRows ?? 1, rows.length));
    const merges = sheet.merges || [];
    const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
    const rowParts = [];

    rows.forEach((row, r) => {
      const cells = [];
      row.forEach((value, c) => {
        if (value === '' || value == null) return;
        const ref = `${colName(c)}${r + 1}`;
        const style = r < headerRows ? 1 : 0;
        if (typeof value === 'number' && Number.isFinite(value)) {
          cells.push(`<c r="${ref}" s="${r < headerRows ? 1 : 2}"><v>${value}</v></c>`);
        } else {
          cells.push(`<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`);
        }
      });
      if (cells.length) rowParts.push(`<row r="${r + 1}">${cells.join('')}</row>`);
      else rowParts.push(`<row r="${r + 1}"/>`);
    });

    const dims = rows.length && width ? `A1:${colName(width - 1)}${rows.length}` : 'A1';

    // 열 너비: 내용 길이 기반
    const widths = new Array(width).fill(8);
    rows.slice(0, 200).forEach((row) =>
      row.forEach((v, c) => {
        const len = String(v ?? '').length;
        if (len > widths[c]) widths[c] = len;
      }),
    );
    const cols = width
      ? `<cols>${widths
          .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.min(60, Math.max(8, w * 1.1)).toFixed(2)}" customWidth="1"/>`)
          .join('')}</cols>`
      : '';

    const panes =
      headerRows > 0
        ? `<sheetViews><sheetView tabSelected="1" workbookViewId="0"><pane ySplit="${headerRows}" topLeftCell="A${headerRows + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${headerRows + 1}" sqref="A${headerRows + 1}"/></sheetView></sheetViews>`
        : `<sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews>`;

    const autoFilter = headerRows > 0 && width ? `<autoFilter ref="A1:${colName(width - 1)}${rows.length}"/>` : '';
    const mergeXml = merges.length
      ? `<mergeCells count="${merges.length}">${merges
          .map((m) => {
            const from = `${colName(m.c)}${m.r + 1}`;
            const to = `${colName(m.c + m.cs - 1)}${m.r + m.rs}`;
            return `<mergeCell ref="${from}:${to}"/>`;
          })
          .join('')}</mergeCells>`
      : '';

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<dimension ref="${dims}"/>
${panes}
<sheetFormatPr defaultRowHeight="16.5"/>
${cols}
<sheetData>${rowParts.join('')}</sheetData>
${autoFilter}
${mergeXml}
</worksheet>`;
  }

  function workbookXml(names) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`;
  }

  function workbookRels(count) {
    const sheets = Array.from(
      { length: count },
      (_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    ).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets}
<Relationship Id="rId${count + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
  }

  /* --------------------------------------------------------------- api */

  async function build(sheets, meta = {}) {
    if (!Array.isArray(sheets) || !sheets.length) throw new Error('시트가 없습니다.');
    const used = new Set();
    const named = sheets.map((s, i) => ({ ...s, name: sanitizeSheetName(s.name || `Sheet${i + 1}`, used) }));

    const entries = [
      { name: '[Content_Types].xml', data: contentTypes(named.length) },
      { name: '_rels/.rels', data: ROOT_RELS },
      { name: 'xl/workbook.xml', data: workbookXml(named.map((s) => s.name)) },
      { name: 'xl/_rels/workbook.xml.rels', data: workbookRels(named.length) },
      { name: 'xl/styles.xml', data: STYLES },
      ...named.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
    ];

    void meta;
    return zip(entries);
  }

  globalThis.XlsxWriter = { build, __internal: { zip, colName, esc, sheetXml } };
})();
