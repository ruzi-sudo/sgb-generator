// src/docx-tool.mjs
// ============================================================
// 1) 从 Buffer 解析 DOCX / PDF → 纯文本 + 黄色高亮片段
// 2) 用 userData 替换模板 DOCX 中的黄色高亮 → 生成新 DOCX
// ============================================================
import path from 'path';
import { createRequire } from 'module';
import AdmZip from 'adm-zip';
import mammoth from 'mammoth';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

// ------------------------------------------------------------
// Part A. 从 Buffer 解析文档
// ------------------------------------------------------------
function extractHighlightsFromDocx(buffer) {
  try {
    const zip = new AdmZip(buffer);
    const xmlBuf = zip.readFile('word/document.xml');
    if (!xmlBuf) return [];
    const xml = xmlBuf.toString('utf8');

    const highlights = [];
    const runRegex = /<w:r[^>]*>(?:(?!<\/w:r>).)*?<w:highlight w:val="yellow"\/>(?:(?!<\/w:r>).)*?<\/w:r>/gs;
    let m;
    while ((m = runRegex.exec(xml)) !== null) {
      let text = '';
      const tRegex = /<w:t[^>]*>(.*?)<\/w:t>/g;
      let tm;
      while ((tm = tRegex.exec(m[0])) !== null) text += tm[1];
      if (text.trim()) highlights.push(text.trim());
    }
    return highlights;
  } catch {
    return [];
  }
}

/**
 * 从 Buffer 解析单个文档
 * @param {string} name   原始文件名（用于判定扩展名）
 * @param {Buffer} buffer 文件内容
 * @returns {Promise<{name:string,text:string,highlights:string[]}>}
 */
export async function parseDocumentBuffer(name, buffer) {
  const ext = path.extname(name).toLowerCase();

  if (ext === '.docx') {
    const text = (await mammoth.extractRawText({ buffer })).value;
    const highlights = extractHighlightsFromDocx(buffer);
    return { name, text, highlights };
  }

  if (ext === '.pdf') {
    const data = await pdfParse(buffer);
    return { name, text: data.text, highlights: [] };
  }

  throw new Error(`不支持的文件类型: ${ext}（仅支持 .docx / .pdf）`);
}

// ------------------------------------------------------------
// Part B. 替换黄色高亮 → 生成新 DOCX
// ------------------------------------------------------------
export const DEFAULT_TEMPLATE_MAPPING = {
  'DD-MM-YYYY': 'date',
  '79456800000030': 'accountNumber',
  'BH75SGBD79456800000030': 'iban',
  'USD': 'currency',
  'FU FANGRONG': 'recipientName',
  '24HAO DIERNONGMAOSHICHANGBEI WANCHEN G ZHEN WANNING SHI HAINAN SHENG 571500 CH INA': 'recipientAddress'
};

/**
 * @param {string} inputPath  模板 DOCX 路径
 * @param {string} outputPath 输出 DOCX 路径
 * @param {Object} userData   结构化数据
 * @param {Object} [mapping]  高亮文本 → userData 键
 */
export function generateAccountDoc(inputPath, outputPath, userData, mapping = DEFAULT_TEMPLATE_MAPPING) {
  const valueByHighlight = {};
  for (const [highlightText, key] of Object.entries(mapping)) {
    if (userData[key] !== undefined && userData[key] !== null) {
      valueByHighlight[highlightText] = String(userData[key]);
    }
  }

  const zip = new AdmZip(inputPath);
  const xmlBuf = zip.readFile('word/document.xml');
  if (!xmlBuf) throw new Error('无法找到 word/document.xml，请确认模板是否为有效的 docx。');
  let xml = xmlBuf.toString('utf8');

  const runRegex = /<w:r[^>]*>(?:(?!<\/w:r>).)*?<w:highlight w:val="yellow"\/>(?:(?!<\/w:r>).)*?<\/w:r>/gs;

  xml = xml.replace(runRegex, (runXml) => {
    let innerText = '';
    let m;
    const tRegex = /<w:t[^>]*>(.*?)<\/w:t>/g;
    while ((m = tRegex.exec(runXml)) !== null) innerText += m[1];

    const key = innerText.trim();
    if (valueByHighlight[key] === undefined) return runXml;

    const newText = valueByHighlight[key];
    let isFirst = true;
    return runXml.replace(/<w:t[^>]*>(.*?)<\/w:t>/g, (tTag) => {
      if (!isFirst) return '';
      isFirst = false;
      const attrs = (tTag.match(/<w:t([^>]*)>/) || [,''])[1];
      return `<w:t${attrs}>${newText}</w:t>`;
    });
  });

  zip.updateFile('word/document.xml', Buffer.from(xml, 'utf8'));
  zip.writeZip(outputPath);
}