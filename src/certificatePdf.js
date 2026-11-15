// The certificate a student downloads once the instructor has approved the request.
// Drawn with PDFKit (standard fonts, so names are limited to Latin letters: the request form enforces it).
const PDFDocument = require('pdfkit');

const MAROON = '#751423';
const CORAL = '#C55963';
const CREAM = '#FEF9F3';
const BEIGE = '#F1E6D7';
const INK = '#3a2a2a';

/** @returns Promise<Buffer> */
function certificatePdf({ title, name, course, number, issuedAt }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0, info: { Title: `Certificate - ${name}`, Author: 'ThugilCreation' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width;
    const H = doc.page.height;
    const mid = W / 2;

    doc.rect(0, 0, W, H).fill(CREAM);
    doc.lineWidth(5).strokeColor(MAROON).rect(26, 26, W - 52, H - 52).stroke();
    doc.lineWidth(1.2).strokeColor(CORAL).rect(40, 40, W - 80, H - 80).stroke();
    for (const [x, y] of [[40, 40], [W - 40, 40], [40, H - 40], [W - 40, H - 40]]) doc.circle(x, y, 7).fill(MAROON);

    doc.fillColor(MAROON).font('Times-Bold').fontSize(20).text('THUGILCREATION', 0, 78, { width: W, align: 'center', characterSpacing: 6 });
    doc.fillColor(CORAL).fontSize(11).font('Helvetica').text('CRAFTING TRADITION', 0, 106, { width: W, align: 'center', characterSpacing: 4 });

    doc.fillColor(MAROON).font('Times-Bold').fontSize(46).text('Certificate of Completion', 0, 146, { width: W, align: 'center' });
    doc.moveTo(mid - 70, 212).lineTo(mid + 70, 212).lineWidth(2).strokeColor(CORAL).stroke();

    doc.fillColor(INK).font('Helvetica').fontSize(14).text('This is to certify that', 0, 238, { width: W, align: 'center' });
    doc.fillColor(MAROON).font('Times-BoldItalic').fontSize(38).text(`${title ? `${title} ` : ''}${name}`, 60, 266, { width: W - 120, align: 'center' });
    doc.moveTo(mid - 220, 318).lineTo(mid + 220, 318).lineWidth(0.8).strokeColor(MAROON).stroke();

    doc.fillColor(INK).font('Helvetica').fontSize(14).text('has successfully completed the course', 0, 336, { width: W, align: 'center' });
    doc.fillColor(MAROON).font('Times-Bold').fontSize(24).text(course, 90, 362, { width: W - 180, align: 'center' });

    const date = new Date(issuedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    const baseY = H - 120;
    doc.lineWidth(0.8).strokeColor(INK);
    doc.moveTo(110, baseY).lineTo(290, baseY).stroke();
    doc.moveTo(W - 290, baseY).lineTo(W - 110, baseY).stroke();
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(12).text(date, 110, baseY - 20, { width: 180, align: 'center' });
    doc.font('Helvetica').fontSize(10).fillColor('#6A5A56').text('DATE OF ISSUE', 110, baseY + 6, { width: 180, align: 'center', characterSpacing: 1.5 });
    doc.font('Times-Italic').fontSize(16).fillColor(MAROON).text('ThugilCreation', W - 290, baseY - 24, { width: 180, align: 'center' });
    doc.font('Helvetica').fontSize(10).fillColor('#6A5A56').text('AUTHORISED SIGNATORY', W - 290, baseY + 6, { width: 180, align: 'center', characterSpacing: 1.5 });

    doc.rect(mid - 120, H - 108, 240, 34).fill(BEIGE);
    doc.fillColor(MAROON).font('Helvetica-Bold').fontSize(11).text(number, mid - 120, H - 98, { width: 240, align: 'center', characterSpacing: 1 });
    doc.fillColor('#6A5A56').font('Helvetica').fontSize(8.5).text('CERTIFICATE NO.', mid - 120, H - 70, { width: 240, align: 'center', characterSpacing: 1.5 });
    doc.end();
  });
}

module.exports = { certificatePdf };
