// src/doc-convert.mjs
// ============================================================
// 把生成的 DOCX 转成其它格式（旧版 Word 二进制 .doc / PDF）。
// 使用 LibreOffice 无头模式：
//   - 优先使用环境变量 LIBREOFFICE_BIN 指定的可执行文件
//   - 否则使用 PATH 中的 soffice / libreoffice
// 如果是便携版 LibreOffice，可用 LIBREOFFICE_LD_LIBRARY_PATH 补充动态库路径。
// ============================================================
import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { ensureLibreOffice, libreofficePathIfReady, loEnv } from './libreoffice-portable.mjs';

// 各目标格式：扩展名 + 文件头魔数（用于校验产物是否真的转成功）
const FORMATS = {
  doc: {
    ext: 'doc',
    label: 'Word 97-2003 二进制文档（.doc）',
    magic: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
  },
  pdf: {
    ext: 'pdf',
    label: 'PDF 文档（.pdf）',
    magic: Buffer.from('%PDF-')
  }
};

// 用独立目录做 LibreOffice 用户配置，避免污染真实 HOME
const PROFILE_DIR = path.join(os.tmpdir(), 'sgb-libreoffice-profile');
const TIMEOUT_MS = Number(process.env.LIBREOFFICE_TIMEOUT_MS || 120_000);

// 串行队列：同一时刻只跑一个 LibreOffice，避免多个实例争抢同一个用户配置目录
let queue = Promise.resolve();

function enqueue(task) {
  const run = queue.then(task);
  queue = run.catch(() => {}); // 单次失败不阻塞后续任务
  return run;
}

/** 优先用可用的 LibreOffice（env / lib 缓存 / 系统），必要时自动下载安装；都没有则回退 PATH */
async function resolveBin() {
  return (await ensureLibreOffice()) || 'soffice';
}

function buildEnv() {
  const env = loEnv();
  const extraLibs = process.env.LIBREOFFICE_LD_LIBRARY_PATH;
  if (extraLibs) {
    env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH
      ? `${extraLibs}:${env.LD_LIBRARY_PATH}`
      : extraLibs;
  }
  return env;
}

function run(bin, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`LibreOffice 转换超时（>${TIMEOUT_MS}ms）`));
    }, TIMEOUT_MS);

    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function convertOnce(inputPath, outputPath, formatKey) {
  const fmt = FORMATS[formatKey];
  if (!fmt) throw new Error(`不支持的转换格式：${formatKey}`);

  await fs.mkdir(PROFILE_DIR, { recursive: true });
  const outDir = path.dirname(outputPath);
  await fs.mkdir(outDir, { recursive: true });

  // LibreOffice 会输出 <输入文件主名>.<ext>，先清掉目标，确保拿到的是本次产物
  const producedByLo = path.join(
    outDir,
    path.basename(inputPath).replace(/\.[^.]+$/, '') + '.' + fmt.ext
  );
  await fs.rm(outputPath, { force: true });
  if (producedByLo !== outputPath) await fs.rm(producedByLo, { force: true });

  const bin = await resolveBin();
  const args = [
    '--headless',
    '--nologo',
    '--nofirststartwizard',
    `-env:UserInstallation=${pathToFileURL(PROFILE_DIR).href}`,
    '--convert-to', fmt.ext,
    '--outdir', outDir,
    inputPath
  ];

  const { code, stderr } = await run(bin, args, buildEnv());

  if (producedByLo !== outputPath && await exists(producedByLo)) {
    await fs.rename(producedByLo, outputPath);
  }

  if (code !== 0 || !(await exists(outputPath))) {
    const tail = stderr.trim().split('\n').filter(Boolean).slice(-3).join(' | ');
    throw new Error(`LibreOffice 转换失败（exit ${code}）：${tail || '无错误输出'}`);
  }

  const head = (await fs.readFile(outputPath)).subarray(0, fmt.magic.length);
  if (!head.equals(fmt.magic)) {
    throw new Error(`转换结果不是有效的 ${fmt.label}`);
  }
}

/** 把 docx 转成真正的 .doc（Word 97-2003 二进制）。串行执行。 */
export function convertDocxToDoc(inputPath, outputPath) {
  return enqueue(() => convertOnce(inputPath, outputPath, 'doc'));
}

/** 把 docx 转成 .pdf。串行执行。 */
export function convertDocxToPdf(inputPath, outputPath) {
  return enqueue(() => convertOnce(inputPath, outputPath, 'pdf'));
}

/**
 * 探测 LibreOffice 是否可用，返回版本号字符串或 null。
 */
export async function detectLibreOffice() {
  try {
    await fs.mkdir(PROFILE_DIR, { recursive: true });
    const bin = await libreofficePathIfReady(); // 只检测现成的，不触发下载
    if (!bin) return null;
    const { code, stdout, stderr } = await run(
      bin,
      ['--headless', '--nologo', '--nofirststartwizard', '--version'],
      buildEnv()
    );
    if (code !== 0) return null;
    const line = (stdout + stderr).trim().split('\n').find(l => /libreoffice/i.test(l));
    return (line || 'LibreOffice').trim();
  } catch {
    return null;
  }
}
