// src/libreoffice-portable.mjs
// ============================================================
// 管理项目内置（lib/）的便携版 LibreOffice。
//
// 目录结构：
//   lib/
//     debs/             # Ubuntu 的 .deb 安装包（提交进仓库）
//     libreoffice/      # 解包产物（自动生成，已 gitignore）
//
// 为什么提交的是 .deb 而不是解包后的文件？
//   解包后最大的 program/libmergedlo.so 超过 100MB，超过 GitHub 单文件硬上限，
//   无法用普通 git 推送；而每个 .deb 都远小于 100MB，可以安全提交。
//   首次使用时会自动用 dpkg-deb 解包并做必要修补。
// ============================================================
import { spawn } from 'child_process';
import fs from 'fs/promises';
import fssync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

export const LIB_DIR  = path.join(projectRoot, 'lib');
export const DEB_DIR  = path.join(LIB_DIR, 'debs');
export const LO_DIR   = path.join(LIB_DIR, 'libreoffice');            // 解包产物
const LO_BASE         = path.join(LO_DIR, 'usr/lib/libreoffice');
const LO_PROGRAM      = path.join(LO_BASE, 'program');
export const LO_BIN   = path.join(LO_PROGRAM, 'soffice');

const MULTIARCH = process.arch === 'x64'
  ? 'x86_64-linux-gnu'
  : `${process.arch}-linux-gnu`;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`${cmd} ${args.join(' ')} 失败（exit ${code}）：${stderr.trim()}`)));
  });
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}
async function isSymlink(p) {
  try { return (await fs.lstat(p)).isSymbolicLink(); } catch { return false; }
}

/** 解包后做脱离系统路径所必需的修补 */
async function patchTree() {
  // 1) fundamentalrc 里 BRAND_BASE_DIR 被硬编码成 /usr/lib/libreoffice，
  //    解包到 lib/ 后必须改成实际绝对路径，否则启动时抛 DeploymentException。
  const frc = path.join(LO_PROGRAM, 'fundamentalrc');
  if (await exists(frc)) {
    const s = (await fs.readFile(frc, 'utf8'))
      .replace(/^BRAND_BASE_DIR=.*$/m, `BRAND_BASE_DIR=file://${LO_BASE}`);
    await fs.writeFile(frc, s);
  }

  const share = path.join(LO_BASE, 'share');

  // 2) share/registry/main.xcd 是指向 /etc/libreoffice/... 的软链，脱离系统后失效。
  //    用同目录下的真实文件 .registry/main.xcd 替代。
  const regLink = path.join(share, 'registry/main.xcd');
  const regReal = path.join(share, '.registry/main.xcd');
  if (await exists(regReal) && await isSymlink(regLink)) {
    await fs.rm(regLink, { force: true });
    await fs.copyFile(regReal, regLink);
  }

  // 3) 另有两个指向系统目录的软链，替换为空目录
  for (const rel of ['prereg/bundled', 'uno_packages/cache']) {
    const p = path.join(share, rel);
    if (await isSymlink(p)) {
      await fs.rm(p, { force: true });
      await fs.mkdir(p, { recursive: true });
    }
  }
}

async function extractDebs() {
  const debs = (await fs.readdir(DEB_DIR)).filter(f => f.endsWith('.deb')).sort();
  if (debs.length === 0) throw new Error(`lib/debs 下未找到任何 .deb：${DEB_DIR}`);

  await fs.rm(LO_DIR, { recursive: true, force: true });
  await fs.mkdir(LO_DIR, { recursive: true });
  for (const f of debs) {
    await run('dpkg-deb', ['-x', path.join(DEB_DIR, f), LO_DIR]);
  }
  await patchTree();
}

let ensurePromise = null;

/**
 * 确保便携版 LibreOffice 可用，返回 soffice 可执行文件路径。
 * - 已解包：直接返回
 * - 未解包但有 lib/debs：自动解包（只做一次）
 * - 都没有：返回 null
 */
export function ensureLibreOffice() {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      if (await exists(LO_BIN)) return LO_BIN;
      if (await exists(DEB_DIR)) await extractDebs();
      return (await exists(LO_BIN)) ? LO_BIN : null;
    })().catch(err => {
      ensurePromise = null; // 允许下次重试
      throw err;
    });
  }
  return ensurePromise;
}

/** 运行便携版 LibreOffice 所需的环境变量（LD_LIBRARY_PATH / 无头渲染后端等） */
export function loEnv() {
  const ldPaths = [LO_PROGRAM, path.join(LO_DIR, 'usr/lib', MULTIARCH)]
    .filter(p => fssync.existsSync(p));
  const env = {
    ...process.env,
    SAL_USE_VCLPLUGIN: 'svp',
    SAL_DISABLE_WATCHDOG: '1'
  };
  if (ldPaths.length) {
    const ld = ldPaths.join(':');
    env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH ? `${ld}:${env.LD_LIBRARY_PATH}` : ld;
  }
  return env;
}
