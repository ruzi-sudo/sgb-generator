// src/docx-tool.mjs
// ============================================================
// Part A: 从 Buffer 解析上传文档（DOCX / PDF）→ 纯文本 + 高亮
// Part B: 用 userData 替换模板 DOCX 中的 {{$Field}} 占位符 → 生成新 DOCX
// ============================================================
import path from 'path';
import { createRequire } from 'module';
import AdmZip from 'adm-zip';
import mammoth from 'mammoth';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

// ============================================================
// Part A. 解析上传文档
// ============================================================
function extractHighlightsFromDocx(buffer) {
  try {
    const zip = new AdmZip(buffer);
    const xmlBuf = zip.readFile('word/document.xml');
    if (!xmlBuf) return [];
    const xml = xmlBuf.toString('utf8');

    const highlights = [];
    const runRegex = /<w:r\b[^>]*>(?:(?!<\/w:r>)[\s\S])*?<w:highlight\b[^>]*\/>(?:(?!<\/w:r>)[\s\S])*?<\/w:r>/g;
    let m;
    while ((m = runRegex.exec(xml)) !== null) {
      let text = '';
      const tRegex = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
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
 * 解析单个上传文档
 * @param {string} name
 * @param {Buffer} buffer
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

// ============================================================
// Part B. 替换 {{$Field}} 占位符
// ============================================================
function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// 大小写不敏感 + 支持内部空格：{{$Date}} / {{ $date }} 均可
const PLACEHOLDER_REGEX = /\{\{\s*\$(\w+)\s*\}\}/g;

/**
 * 生成新 DOCX
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {Object} userData
 */
export function generateAccountDoc(inputPath, outputPath, userData) {
  if (!userData || typeof userData !== 'object') {
    throw new Error('userData 无效');
  }

  const valueByField = {};
  for (const [k, v] of Object.entries(userData)) {
    if (v === undefined || v === null) continue;
    valueByField[k.toLowerCase()] = String(v);
  }

  const zip = new AdmZip(inputPath);
  const xmlBuf = zip.readFile('word/document.xml');
  if (!xmlBuf) throw new Error('无法找到 word/document.xml，请确认模板是否为有效的 docx。');
  let xml = xmlBuf.toString('utf8');

  let replaced = 0;
  const foundPlaceholders = new Set();
  const missedPlaceholders = new Set();

  // ---------- 第一步：单个 <w:t> 内替换 ----------
  xml = xml.replace(/<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g, (whole, attrs, content) => {
    if (!content.includes('{{')) return whole;

    const newContent = content.replace(PLACEHOLDER_REGEX, (ph, fieldName) => {
      foundPlaceholders.add(ph);
      const val = valueByField[fieldName.toLowerCase()];
      if (val === undefined) {
        missedPlaceholders.add(ph);
        return ph;
      }
      replaced++;
      return escapeXml(val);
    });

    if (newContent === content) return whole;
    const a = attrs || '';
    return `<w:t${a} xml:space="preserve">${newContent}</w:t>`;
  });

  // ---------- 第二步：段落级兜底（占位符被 Word 拆到多个 <w:t>） ----------
  xml = xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paraXml) => {
    const ts = [];
    const re = /<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let m;
    while ((m = re.exec(paraXml)) !== null) {
      ts.push({ start: m.index, end: m.index + m[0].length, attrs: m[1] || '', text: m[2] });
    }
    if (ts.length < 2) return paraXml;

    const combined = ts.map(t => t.text).join('');
    if (!combined.includes('{{')) return paraXml;

    const newCombined = combined.replace(PLACEHOLDER_REGEX, (ph, fieldName) => {
      foundPlaceholders.add(ph);
      const val = valueByField[fieldName.toLowerCase()];
      if (val === undefined) {
        missedPlaceholders.add(ph);
        return ph;
      }
      replaced++;
      return escapeXml(val);
    });

    if (newCombined === combined) return paraXml;

    let out = paraXml;
    for (let i = ts.length - 1; i >= 0; i--) {
      const t = ts[i];
      const text = i === 0 ? newCombined : '';
      const newTag = `<w:t${t.attrs} xml:space="preserve">${text}</w:t>`;
      out = out.substring(0, t.start) + newTag + out.substring(t.end);
    }
    return out;
  });

  // ---------- 诊断日志 ----------
  console.log('\n=== 占位符扫描 ===');
  console.log(`  发现占位符 ${foundPlaceholders.size} 种：${[...foundPlaceholders].join(', ') || '（无）'}`);
  console.log(`  成功替换 ${replaced} 处`);
  if (missedPlaceholders.size) {
    console.log(`  ⚠️ 未匹配到字段的占位符：${[...missedPlaceholders].join(', ')}`);
    console.log(`     可用字段：${Object.keys(valueByField).join(', ')}`);
  }

  if (replaced === 0) {
    throw new Error(
      '没有任何 {{$Field}} 占位符被替换。请检查：\n' +
      '  · 模板里是否真的用了 {{$Field}} 格式（半角括号 + 半角 $）？\n' +
      '  · userData 的字段名是否与占位符对应（大小写不敏感）？'
    );
  }

  zip.updateFile('word/document.xml', Buffer.from(xml, 'utf8'));
  zip.writeZip(outputPath);
  console.log(`✅ 已写出：${outputPath}\n`);
}