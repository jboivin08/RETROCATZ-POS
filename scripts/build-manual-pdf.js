const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

const ROOT = path.join(__dirname, "..");
const INPUT = path.join(ROOT, "VAULTCORE_POS_MANUAL.md");
const OUTPUT = path.join(ROOT, "VaultCore_POS_Instruction_Manual.pdf");

const raw = fs.readFileSync(INPUT, "utf8").replace(/\r\n/g, "\n");
const sourceLines = raw.split("\n");

function cleanInline(text) {
  return String(text || "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .trim();
}

function buildManualLines(lines) {
  const out = [];
  let skipToc = false;
  for (const line of lines) {
    if (/^## Table Of Contents\s*$/i.test(line)) {
      skipToc = true;
      continue;
    }
    if (skipToc) {
      if (/^## 1\.\s+/.test(line)) {
        skipToc = false;
      } else {
        continue;
      }
    }
    out.push(line);
  }
  return out;
}

const lines = buildManualLines(sourceLines);
const sections = lines
  .filter((line) => /^##\s+/.test(line))
  .map((line) => cleanInline(line.replace(/^##\s+/, "")));

const doc = new PDFDocument({
  size: "LETTER",
  margin: 54,
  bufferPages: true,
  autoFirstPage: true,
  info: {
    Title: "VaultCore POS Instruction Manual",
    Author: "VaultCore POS",
    Subject: "Staff and owner instruction manual",
    Keywords: "VaultCore POS, instruction manual, retail POS"
  }
});

const stream = fs.createWriteStream(OUTPUT);
doc.pipe(stream);

const page = {
  width: doc.page.width,
  height: doc.page.height,
  margin: 54,
  bottom: 720,
  contentWidth: doc.page.width - 108
};

const colors = {
  ink: "#172033",
  muted: "#58667a",
  line: "#d8dee8",
  blue: "#1f5fbf",
  paleBlue: "#eef4ff"
};

let y = page.margin;
const sectionPages = new Map();

function currentPageNumber() {
  return doc.bufferedPageRange().count;
}

function addPage() {
  doc.addPage();
  y = page.margin;
}

function ensureSpace(height) {
  if (y + height > page.bottom) addPage();
}

function textBlock(text, options = {}) {
  const font = options.font || "Helvetica";
  const size = options.size || 10.5;
  const color = options.color || colors.ink;
  const width = options.width || page.contentWidth;
  const x = options.x || page.margin;
  const indent = options.indent || 0;
  const gapAfter = options.gapAfter ?? 8;
  const lineGap = options.lineGap ?? 2;
  const clean = cleanInline(text);
  if (!clean) {
    y += options.blank || 7;
    return;
  }

  doc.font(font).fontSize(size);
  const height = doc.heightOfString(clean, { width: width - indent, lineGap });
  ensureSpace(height + gapAfter);
  doc.fillColor(color).text(clean, x + indent, y, {
    width: width - indent,
    lineGap,
    align: options.align || "left"
  });
  y += height + gapAfter;
}

function heading(text, level) {
  const clean = cleanInline(text);
  if (level === 2) {
    if (y > page.margin + 5) addPage();
    sectionPages.set(clean, currentPageNumber());
    doc.rect(page.margin, y, page.contentWidth, 34).fill(colors.paleBlue);
    doc.fillColor(colors.blue).font("Helvetica-Bold").fontSize(17).text(clean, page.margin + 12, y + 9, {
      width: page.contentWidth - 24
    });
    y += 48;
    return;
  }
  if (level === 3) {
    ensureSpace(30);
    doc.fillColor(colors.ink).font("Helvetica-Bold").fontSize(13).text(clean, page.margin, y, {
      width: page.contentWidth
    });
    y += 22;
    return;
  }
}

function listItem(text, marker) {
  const clean = cleanInline(text);
  const label = marker || "-";
  const size = 10.5;
  const x = page.margin;
  const labelWidth = 24;
  doc.font("Helvetica").fontSize(size);
  const height = doc.heightOfString(clean, { width: page.contentWidth - labelWidth, lineGap: 2 });
  ensureSpace(height + 6);
  doc.fillColor(colors.ink).text(label, x, y, { width: labelWidth });
  doc.text(clean, x + labelWidth, y, { width: page.contentWidth - labelWidth, lineGap: 2 });
  y += height + 6;
}

function divider() {
  ensureSpace(12);
  doc.moveTo(page.margin, y).lineTo(page.margin + page.contentWidth, y).strokeColor(colors.line).lineWidth(0.8).stroke();
  y += 14;
}

function coverPage() {
  doc.rect(0, 0, doc.page.width, doc.page.height).fill("#f8fbff");
  doc.fillColor(colors.blue).font("Helvetica-Bold").fontSize(28).text("VaultCore POS", page.margin, 128, {
    width: page.contentWidth,
    align: "center"
  });
  doc.fillColor(colors.ink).fontSize(21).text("Instruction Manual", page.margin, 170, {
    width: page.contentWidth,
    align: "center"
  });
  doc.fillColor(colors.muted).font("Helvetica").fontSize(11).text("Printable staff and owner guide", page.margin, 212, {
    width: page.contentWidth,
    align: "center"
  });
  doc.moveTo(150, 260).lineTo(doc.page.width - 150, 260).strokeColor(colors.line).lineWidth(1).stroke();
  doc.fillColor(colors.ink).fontSize(12).text("Daily use, inventory rules, checkout, customers, bundles, layaways, trade-ins, reports, closeout, accounting, events, settings, and troubleshooting.", 110, 300, {
    width: doc.page.width - 220,
    align: "center",
    lineGap: 5
  });
  doc.fillColor(colors.muted).fontSize(10).text("Last updated: May 8, 2026", page.margin, 650, {
    width: page.contentWidth,
    align: "center"
  });
}

function drawToc() {
  doc.switchToPage(1);
  let tocY = page.margin;
  doc.fillColor(colors.blue).font("Helvetica-Bold").fontSize(20).text("Table Of Contents", page.margin, tocY);
  tocY += 34;
  doc.font("Helvetica").fontSize(10.5).fillColor(colors.ink);
  sections.forEach((title) => {
    if (tocY > page.bottom - 18) return;
    const pageNo = sectionPages.get(title) || "";
    doc.text(title, page.margin, tocY, { width: page.contentWidth - 50, continued: false });
    doc.text(String(pageNo), page.margin + page.contentWidth - 40, tocY, { width: 40, align: "right" });
    tocY += 18;
  });
}

function drawFooter(pageIndex, totalPages) {
  doc.switchToPage(pageIndex);
  if (pageIndex === 0) return;
  const pageNo = pageIndex + 1;
  doc.moveTo(page.margin, 742).lineTo(page.margin + page.contentWidth, 742).strokeColor(colors.line).lineWidth(0.6).stroke();
  doc.fillColor(colors.muted).font("Helvetica").fontSize(8.5).text("VaultCore POS Instruction Manual", page.margin, 752, {
    width: page.contentWidth / 2
  });
  doc.text(`Page ${pageNo} of ${totalPages}`, page.margin + page.contentWidth / 2, 752, {
    width: page.contentWidth / 2,
    align: "right"
  });
}

coverPage();
addPage();
addPage();

for (const line of lines) {
  if (/^#\s+/.test(line)) continue;
  if (/^##\s+/.test(line)) {
    heading(line.replace(/^##\s+/, ""), 2);
    continue;
  }
  if (/^###\s+/.test(line)) {
    heading(line.replace(/^###\s+/, ""), 3);
    continue;
  }
  if (/^\d+\.\s+/.test(line)) {
    const match = line.match(/^(\d+\.)\s+(.*)$/);
    listItem(match[2], match[1]);
    continue;
  }
  if (/^-\s+/.test(line)) {
    listItem(line.replace(/^-\s+/, ""), "-");
    continue;
  }
  if (/^\s*$/.test(line)) {
    y += 4;
    continue;
  }
  if (/^Examples?:$/i.test(line) || /^Main (areas|buttons|fields|columns):$/i.test(line) || /^Tabs:$/i.test(line) || /^Available tender buttons:$/i.test(line) || /^Statuses:$/i.test(line) || /^Controls:$/i.test(line) || /^Report tabs:$/i.test(line)) {
    textBlock(line, { font: "Helvetica-Bold", gapAfter: 6 });
    continue;
  }
  if (/^Important:$/i.test(line) || /^Rule:$/i.test(line)) {
    divider();
    textBlock(line, { font: "Helvetica-Bold", gapAfter: 6 });
    continue;
  }
  textBlock(line);
}

drawToc();

const range = doc.bufferedPageRange();
const totalPages = range.count;
for (let i = 0; i < totalPages; i += 1) {
  drawFooter(i, totalPages);
}

doc.end();

stream.on("finish", () => {
  const size = fs.statSync(OUTPUT).size;
  console.log(`Created ${OUTPUT} (${size} bytes)`);
});
