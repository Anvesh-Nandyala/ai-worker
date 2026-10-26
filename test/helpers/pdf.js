// Minimal ASCII PDF fixtures. This is test/sample data, not an agent PDF writer.
export function pdfFixture(pages = [['Sample invoice']]) {
  const objects = ['', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (const lines of pages) {
    const pageID = objects.length + 1;
    const contentID = pageID + 1;
    kids.push(`${pageID} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentID} 0 R >>`);
    const escape = value => value.replace(/[\\()]/g, '\\$&');
    const stream = 'BT /F1 13 Tf 22 TL 54 728 Td\n' + lines.map(line => `(${escape(line)}) Tj T*`).join('\n') + '\nET';
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${kids.join(' ')}] >>`;
  let output = '%PDF-1.4\n';
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}
