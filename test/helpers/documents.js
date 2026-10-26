import * as XLSX from 'xlsx';
import { zipSync, strToU8 } from 'fflate';

// Small format fixtures for reader tests, not user-facing document artifacts.
export function workbookFixture(bookType = 'xlsx', manyRows = false) {
  const book = XLSX.utils.book_new();
  const rows = manyRows ? [['Item', 'Amount'], ...Array.from({ length: 300 }, (_, index) => [`Item ${index + 1}`, index + 1])] : [['Item', 'Amount'], ['Notebook', 80], ['Lamp', 950], ['Total', 1030], ['Uncached', null]];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  if (!manyRows) {
    sheet.B4 = { t: 'n', v: 1030, f: 'SUM(B2:B3)' };
    sheet.B5 = { t: 'n', f: 'SUM(B2:B3)' };
  }
  XLSX.utils.book_append_sheet(book, sheet, 'Costs');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Owner', 'Anvesh']]), 'Notes');
  return XLSX.write(book, { type: 'buffer', bookType });
}

export function docxFixture(text = 'Project Cedar') {
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:p><w:r><w:t>Owner: Anvesh</w:t></w:r></w:p><w:p><w:r><w:t>Read &amp; summarize existing files.</w:t></w:r></w:p></w:body></w:document>`;
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8(xml),
    'word/_rels/document.xml.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>')
  }));
}

export function slidesFixture(reordered = false) {
  const slide = text => strToU8(`<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
  return Buffer.from(zipSync({
    'ppt/presentation.xml': strToU8(`<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${(reordered ? ['second', 'first'] : ['first', 'second']).map(id => `<p:sldId r:id="${id}"/>`).join('')}</p:sldIdLst></p:presentation>`),
    'ppt/_rels/presentation.xml.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="first" Target="slides/slide1.xml"/><Relationship Id="second" Target="slides/slide2.xml"/></Relationships>'),
    'ppt/slides/slide2.xml': slide('Second slide &amp; decisions'), 'ppt/slides/slide1.xml': slide('First slide Project Cedar')
  }));
}

export function openDocumentFixture() {
  return Buffer.from(zipSync({ 'content.xml': strToU8('<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:h>Project Cedar</text:h><text:p>Read<text:s/>existing<text:tab/>files.</text:p></office:text></office:body></office:document-content>') }));
}
