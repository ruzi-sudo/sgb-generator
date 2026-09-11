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

const PLACEHOLDER_REGEX = /\{\{\s*\$(\w+)\s*\}\}/g;

/** 抽出一个 run 内所有 <w:t> 文本 */
function extractRunText(runXml) {
  let text = '';
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let m;
  while ((m = re.exec(runXml)) !== null) text += m[1];
  return text;
}

/** 把 run 内所有 <w:t> 改成 newText（第一个承载全部，其余清空，保留原属性） */
function setRunText(runXml, newText) {
  let first = true;
  return runXml.replace(/<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g, (whole, attrs) => {
    if (!first) return '';
    first = false;
    // 去掉原有的 xml:space，避免与下面新增的重复。
    // 重复属性会让 XML 非法，Word / LibreOffice 会判定文件损坏而拒绝打开。
    const cleanAttrs = (attrs || '').replace(/\s*xml:space\s*=\s*("[^"]*"|'[^']*')/g, '');
    return `<w:t${cleanAttrs} xml:space="preserve">${escapeXml(newText)}</w:t>`;
  });
}

/**
 * ★ 段落级替换：
 *   1) 抽出一个 <w:p> 里所有 run 及其文本
 *   2) 把所有 run 的文本拼成整段字符串
 *   3) 在整段字符串里做 {{$Field}} 替换
 *   4) 把替换后的整段文本塞回第一个 run，其余 run 的 <w:t> 清空
 *
 * 优点：不关心 Word 怎么拆 run / 怎么分颜色，一律能命中
 */
function replaceInParagraph(paraXml, valueByField, stats) {
  // 收集所有 run
  const runs = [];
  const runRe = /<w:r\b[^>]*>[\s\S]*?<\/w:r>/g;
  let m;
  while ((m = runRe.exec(paraXml)) !== null) {
    runs.push({
      start: m.index,
      end: m.index + m[0].length,
      xml: m[0],
      text: extractRunText(m[0])
    });
  }
  if (runs.length === 0) return paraXml;

  // 段落整文本
  const combined = runs.map(r => r.text).join('');
  if (!combined.includes('{{')) return paraXml;

  // 做替换
  const newCombined = combined.replace(PLACEHOLDER_REGEX, (ph, fieldName) => {
    stats.found.add(ph);
    const val = valueByField[fieldName.toLowerCase()];
    if (val === undefined) {
      stats.missed.add(ph);
      return ph;
    }
    stats.replaced++;
    return escapeXml(val);
  });

  if (newCombined === combined) return paraXml;

  // 选一个「带 <w:t> 的」run 作为承载文本的 run，避免把文字塞进只有图片/制表符的 run 里丢失
  let carrier = runs.findIndex(r => /<w:t[\s>]/.test(r.xml));
  if (carrier === -1) carrier = 0;

  // 把 newCombined 放回 carrier run，其余 run 清空
  // 从后往前替换以避免位置偏移
  let out = paraXml;
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i];
    const text = i === carrier ? newCombined : '';
    const newXml = setRunText(r.xml, text);
    out = out.substring(0, r.start) + newXml + out.substring(r.end);
  }
  return out;
}

/**
 * 生成新 DOCX
 */
export function generateAccountDoc(inputPath, outputPath, userData) {
  if (!userData || typeof userData !== 'object') throw new Error('userData 无效');

  // 字段索引：小写字段名 → 字符串值
  const valueByField = {};
  for (const [k, v] of Object.entries(userData)) {
    if (v === undefined || v === null) continue;
    valueByField[k.toLowerCase()] = String(v);
  }

  const zip = new AdmZip(inputPath);
  const xmlBuf = zip.readFile('word/document.xml');
  if (!xmlBuf) throw new Error('无法找到 word/document.xml，请确认模板是否为有效的 docx。');
  let xml = xmlBuf.toString('utf8');

  const stats = { found: new Set(), missed: new Set(), replaced: 0 };

  // ---------- 诊断日志 ----------
  console.log('\n=== 模板占位符诊断 ===');
  {
    const candidates = [];
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      if (m[1].includes('{') || m[1].includes('$') || m[1].includes('}')) {
        candidates.push(m[1]);
      }
    }
    console.log(`含 {/}/  的 <w:t> 块共 ${candidates.length} 个：`);
    candidates.slice(0, 40).forEach((t, i) => console.log(`    [${i}] ${JSON.stringify(t)}`));
    if (candidates.length === 0) {
      console.log('  ⚠️ 一个都没找到 → 占位符被拆进多个相邻 <w:t>，将由段落级替换处理。');
    }
  }

  // ---------- 段落级替换 ----------
  const paraRegex = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
  let paraCount = 0;
  xml = xml.replace(paraRegex, (paraXml) => {
    paraCount++;
    return replaceInParagraph(paraXml, valueByField, stats);
  });

  // ---------- 结果 ----------
  console.log('\n=== 替换结果 ===');
  console.log(`  扫描段落 ${paraCount} 个`);
  console.log(`  发现占位符 ${stats.found.size} 种：${[...stats.found].join(', ') || '（无）'}`);
  console.log(`  成功替换 ${stats.replaced} 处`);
  if (stats.missed.size) {
    console.log(`  ⚠️ 未匹配到字段的占位符：${[...stats.missed].join(', ')}`);
    console.log(`     可用字段：${Object.keys(valueByField).join(', ')}`);
  }

  if (stats.replaced === 0) {
    throw new Error(
      '没有任何 {{$Field}} 占位符被替换。请把上方"模板占位符诊断"的输出贴出来。'
    );
  }

  zip.updateFile('word/document.xml', Buffer.from(xml, 'utf8'));
  zip.writeZip(outputPath);
  console.log(`✅ 已写出：${outputPath}\n`);
}

// ============================================================
// Part C. 字体归一化（供 doc-convert 在转 PDF/DOC 前调用）
// ------------------------------------------------------------
// 模板里混用了 Tahoma / Calibri / Verdana / 宋体 等字体。
// 运行环境通常缺少其中的一种或几种（例如 Linux 上没有 Tahoma），
// LibreOffice 就会把不同的字体回退成不同的替代字体，
// 结果同一份 PDF 里数字、字母、汉字的字体/大小看起来不一致。
// 把整份文档统一成同一种字体后，即使该字体也缺失，
// 回退也是全局一致的，数字和字符大小自然就对齐了。
// ============================================================
const DEFAULT_FONT_FAMILY =
  process.env.PDF_FONT_FAMILY || process.env.DOC_FONT_FAMILY || 'Verdana';

/**
 * 把 DOCX 中的字体引用统一替换为 family（默认 Verdana）。
 * 覆盖 document/styles/settings/页眉页脚 与 theme1.xml。
 */
export function normalizeDocxFonts(inputPath, outputPath, family = DEFAULT_FONT_FAMILY) {
  const font = String(family || 'Verdana');
  const zip = new AdmZip(inputPath);

  const replaceFontAttrs = (xml) =>
    xml.replace(/\bw:(ascii|hAnsi|eastAsia|cs)=("[^"]*"|'[^']*')/g, (_m, attr) =>
      `w:${attr}="${escapeXml(font)}"`
    );

  for (const name of [
    'word/document.xml',
    'word/styles.xml',
    'word/settings.xml',
    'word/header1.xml',
    'word/footer1.xml',
    'word/footer2.xml'
  ]) {
    const entry = zip.getEntry(name);
    if (!entry) continue;
    zip.updateFile(name, Buffer.from(replaceFontAttrs(entry.getData().toString('utf8')), 'utf8'));
  }

  // docDefaults 用 asciiTheme="minorHAnsi" 这类主题引用，需同时改主题定义
  const theme = zip.getEntry('word/theme/theme1.xml');
  if (theme) {
    const xml = theme
      .getData()
      .toString('utf8')
      .replace(
        /(<a:(?:latin|ea|cs)\b[^>]*\btypeface=")[^"]*(")/g,
        (_m, head, tail) => `${head}${escapeXml(font)}${tail}`
      );
    zip.updateFile('word/theme/theme1.xml', Buffer.from(xml, 'utf8'));
  }

  zip.writeZip(outputPath);
  return outputPath;
}
