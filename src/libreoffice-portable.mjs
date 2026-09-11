// src/libreoffice-portable.mjs
// ============================================================
// 按运行环境自动准备 LibreOffice（用于 docx → .doc / PDF 转换）
//
//   Linux  : 优先用 lib/debs 离线解包；没有则下载官方 deb 归档后解包
//   macOS  : 优先用系统已安装的 LibreOffice；没有则下载官方 .dmg 解包到 lib/
//
// 目标平台：Linux x86_64 / arm64、macOS x86_64 / arm64（含 Intel Mac）
//
// 可通过环境变量控制：
//   LIBREOFFICE_BIN           直接指定 soffice，跳过所有自动逻辑
//   LIBREOFFICE_AUTO_INSTALL  设为 0/false 关闭自动下载安装
//   LIBREOFFICE_VERSION       指定版本，默认取 stable 最新版
//   LIBREOFFICE_MIRROR        镜像根地址，默认 https://download.documentfoundation.org/libreoffice
//
// 也可作为脚本单独运行以预安装：node src/libreoffice-portable.mjs
// ============================================================
import { spawn } from 'child_process';
import fs from 'fs/promises';
import fssync from 'fs';
import os from 'os';
import path from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

export const LIB_DIR = path.join(projectRoot, 'lib');
export const DEB_DIR = path.join(LIB_DIR, 'debs');

const IS_LINUX = process.platform === 'linux';
const IS_MAC   = process.platform === 'darwin';
const ARCH     = process.arch; // 'x64' | 'arm64'

// 每个平台/架构独立的解包目录，避免互相覆盖
export const LO_DIR     = path.join(LIB_DIR, `libreoffice-${ARCH}`);
const LO_BASE           = path.join(LO_DIR, 'usr/lib/libreoffice');
const LO_PROGRAM        = path.join(LO_BASE, 'program');
export const LO_BIN     = path.join(LO_PROGRAM, 'soffice');

export const LO_MAC_DIR = path.join(LIB_DIR, `libreoffice-mac-${ARCH}`);
const LO_MAC_APP        = path.join(LO_MAC_DIR, 'LibreOffice.app');
export const LO_MAC_BIN = path.join(LO_MAC_APP, 'Contents/MacOS/soffice');

const MULTIARCH = ARCH === 'x64' ? 'x86_64-linux-gnu' : `${ARCH}-linux-gnu`;

const DEFAULT_MIRROR  = 'https://download.documentfoundation.org/libreoffice';
const DEFAULT_VERSION = '26.2.5';

function mirrorBase() {
  return (process.env.LIBREOFFICE_MIRROR || DEFAULT_MIRROR).replace(/\/+$/, '');
}

export function autoInstallEnabled() {
  const v = (process.env.LIBREOFFICE_AUTO_INSTALL ?? '').toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no');
}

// ------------------------------------------------------------
// 基础工具
// ------------------------------------------------------------
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`${cmd} ${args.join(' ')} 失败（exit ${code}）：${(stderr || stdout).trim()}`)));
  });
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}
async function isSymlink(p) {
  try { return (await fs.lstat(p)).isSymbolicLink(); } catch { return false; }
}
async function findInPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try { await fs.access(p, fssync.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

// ------------------------------------------------------------
// 版本解析 / 下载
// ------------------------------------------------------------
let versionPromise = null;

function cmpVersion(a, b) {
  const A = a.split('.').map(Number);
  const B = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) - (B[i] || 0);
  }
  return 0;
}

/** 取要安装的版本：优先 LIBREOFFICE_VERSION，否则解析 stable 目录里的最新版 */
async function resolveVersion() {
  if (process.env.LIBREOFFICE_VERSION) return process.env.LIBREOFFICE_VERSION;
  if (!versionPromise) {
    versionPromise = (async () => {
      try {
        const res = await fetch(`${mirrorBase()}/stable/`, { redirect: 'follow' });
        const html = await res.text();
        const versions = [...html.matchAll(/href="(\d+\.\d+\.\d+)\//g)].map(m => m[1]);
        versions.sort((a, b) => cmpVersion(b, a));
        if (versions.length) return versions[0];
      } catch { /* 解析失败则用默认版本 */ }
      return DEFAULT_VERSION;
    })();
  }
  return versionPromise;
}

async function download(url, dest, label) {
  console.log(`⬇️  下载 ${label}\n   ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败 ${res.status} ${res.statusText}：${url}`);
  const total = Number(res.headers.get('content-length') || 0);
  let received = 0, lastPct = -1;

  const progress = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (total) {
        const pct = Math.floor((received / total) * 100);
        if (pct >= lastPct + 10) {
          lastPct = pct;
          console.log(`   ... ${pct}% (${(received / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB)`);
        }
      }
      cb(null, chunk);
    }
  });

  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await pipeline(Readable.fromWeb(res.body), progress, fssync.createWriteStream(dest));
  } catch (err) {
    await fs.rm(dest, { force: true });
    throw err;
  }
  console.log(`✅ 下载完成：${label} (${(received / 1048576).toFixed(1)} MB)`);
  return dest;
}

// ------------------------------------------------------------
// Linux：解包 .deb
// ------------------------------------------------------------
/** 解包后做脱离系统路径所必需的修补 */
async function patchTree() {
  // 1) fundamentalrc 里 BRAND_BASE_DIR 被硬编码成 /usr/lib/libreoffice
  const frc = path.join(LO_PROGRAM, 'fundamentalrc');
  if (await exists(frc)) {
    const s = (await fs.readFile(frc, 'utf8'))
      .replace(/^BRAND_BASE_DIR=.*$/m, `BRAND_BASE_DIR=file://${LO_BASE}`);
    await fs.writeFile(frc, s);
  }

  const share = path.join(LO_BASE, 'share');

  // 2) share/registry/main.xcd 是指向 /etc/libreoffice/... 的失效软链
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

async function extractDebsFrom(debDir, destRoot = LO_DIR) {
  const debs = (await fs.readdir(debDir)).filter(f => f.endsWith('.deb')).sort();
  if (debs.length === 0) throw new Error(`目录下未找到 .deb：${debDir}`);

  await fs.rm(destRoot, { recursive: true, force: true });
  await fs.mkdir(destRoot, { recursive: true });
  for (const f of debs) {
    await run('dpkg-deb', ['-x', path.join(debDir, f), destRoot]);
  }
  await patchTree();
}

async function findDebDir(root, depth = 0) {
  if (depth > 4) return null;
  const entries = await fs.readdir(root, { withFileTypes: true });
  if (entries.some(e => e.isFile() && e.name.endsWith('.deb'))) return root;
  for (const e of entries) {
    if (e.isDirectory()) {
      const found = await findDebDir(path.join(root, e.name), depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function provisionLinux() {
  // 1) 内置 debs（仅 x86_64 架构适用），离线解包
  if (ARCH === 'x64' && await exists(DEB_DIR)) {
    const hasDeb = (await fs.readdir(DEB_DIR)).some(f => f.endsWith('.deb'));
    if (hasDeb) {
      console.log('📦 从 lib/debs 离线解包 LibreOffice ...');
      await extractDebsFrom(DEB_DIR);
      return;
    }
  }

  // 2) 下载官方 deb 归档
  const version = await resolveVersion();
  const dirArch = ARCH === 'x64' ? 'x86_64' : 'aarch64';
  const fileArch = ARCH === 'x64' ? 'x86-64' : 'aarch64';
  const name = `LibreOffice_${version}_Linux_${fileArch}_deb.tar.gz`;
  const url = `${mirrorBase()}/stable/${version}/deb/${dirArch}/${name}`;

  const workDir = path.join(os.tmpdir(), `sgb-lo-${process.pid}`);
  const tarPath = path.join(workDir, name);
  await download(url, tarPath, name);

  console.log('📦 解包 deb 归档 ...');
  await run('tar', ['-xzf', tarPath, '-C', workDir]);
  const debDir = await findDebDir(workDir);
  if (!debDir) throw new Error('deb 归档中未找到 .deb 文件');
  await extractDebsFrom(debDir);
}

// ------------------------------------------------------------
// macOS：下载 .dmg 并安装到 lib/
// ------------------------------------------------------------
function macAppCandidates() {
  return [
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    path.join(os.homedir(), 'Applications/LibreOffice.app/Contents/MacOS/soffice')
  ];
}

async function provisionMac() {
  const version = await resolveVersion();
  const dirArch = ARCH === 'x64' ? 'x86_64' : 'aarch64';
  const fileArch = ARCH === 'x64' ? 'x86-64' : 'aarch64';
  const name = `LibreOffice_${version}_MacOS_${fileArch}.dmg`;
  const url = `${mirrorBase()}/stable/${version}/mac/${dirArch}/${name}`;

  const workDir = path.join(os.tmpdir(), `sgb-lo-${process.pid}`);
  const dmgPath = path.join(workDir, name);
  await download(url, dmgPath, name);

  const mnt = path.join(workDir, 'mnt');
  await fs.mkdir(mnt, { recursive: true });
  console.log('📦 挂载 dmg 并安装 LibreOffice.app ...');
  await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mnt, dmgPath]);
  try {
    const srcApp = path.join(mnt, 'LibreOffice.app');
    if (!(await exists(srcApp))) throw new Error('dmg 中未找到 LibreOffice.app');
    await fs.rm(LO_MAC_DIR, { recursive: true, force: true });
    await fs.mkdir(LO_MAC_DIR, { recursive: true });
    // ditto 是 macOS 自带工具，会完整保留符号链接与权限
    await run('ditto', [srcApp, LO_MAC_APP]);
  } finally {
    await run('hdiutil', ['detach', mnt]).catch(() => {});
  }
  // 去掉隔离属性，避免 Gatekeeper 拦截无头执行
  await run('xattr', ['-dr', 'com.apple.quarantine', LO_MAC_APP]).catch(() => {});
}

// ------------------------------------------------------------
// 对外接口
// ------------------------------------------------------------
async function findSystemLibreOffice() {
  if (IS_MAC) {
    for (const p of macAppCandidates()) {
      if (await exists(p)) return p;
    }
  }
  return findInPath('soffice');
}

/**
 * 只做「现成可用」的判断，不触发下载/解包。
 * 顺序：LIBREOFFICE_BIN/SOFFICE_BIN → lib/ 缓存 → 系统安装
 */
export async function libreofficePathIfReady() {
  const envBin = process.env.LIBREOFFICE_BIN || process.env.SOFFICE_BIN;
  if (envBin) return envBin;
  if (IS_LINUX && await exists(LO_BIN)) return LO_BIN;
  if (IS_MAC && await exists(LO_MAC_BIN)) return LO_MAC_BIN;
  return findSystemLibreOffice();
}

let ensurePromise = null;

/**
 * 确保有可用的 LibreOffice，必要时自动下载安装。
 * 返回 soffice 路径，找不到且无法安装时返回 null。
 */
export function ensureLibreOffice() {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      const ready = await libreofficePathIfReady();
      if (ready) return ready;
      if (!autoInstallEnabled()) return null;

      if (IS_LINUX) {
        await provisionLinux();
      } else if (IS_MAC) {
        await provisionMac();
      } else {
        return null; // 其它平台只支持系统已安装 / 显式 LIBREOFFICE_BIN
      }
      return libreofficePathIfReady();
    })().catch(err => {
      ensurePromise = null; // 允许下次重试
      throw err;
    });
  }
  return ensurePromise;
}

/** 运行便携版 LibreOffice 所需的环境变量（仅 Linux 需要） */
export function loEnv() {
  const env = { ...process.env };
  if (!IS_LINUX) return env;

  env.SAL_USE_VCLPLUGIN = 'svp';
  env.SAL_DISABLE_WATCHDOG = '1';

  const ldPaths = [LO_PROGRAM, path.join(LO_DIR, 'usr/lib', MULTIARCH)]
    .filter(p => fssync.existsSync(p));
  if (ldPaths.length) {
    const ld = ldPaths.join(':');
    env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH ? `${ld}:${env.LD_LIBRARY_PATH}` : ld;
  }
  return env;
}

// ------------------------------------------------------------
// 作为脚本直接运行：预安装
//   node src/libreoffice-portable.mjs
// ------------------------------------------------------------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  console.log(`🖥  平台：${process.platform} / ${process.arch}${autoInstallEnabled() ? '' : '（已禁用自动安装）'}`);
  ensureLibreOffice()
    .then(bin => {
      if (bin) {
        console.log(`✅ LibreOffice 就绪：${bin}`);
        process.exit(0);
      }
      console.error('❌ 未找到可用的 LibreOffice，且未能自动安装。可设置 LIBREOFFICE_BIN 手动指定。');
      process.exit(1);
    })
    .catch(err => {
      console.error(`❌ 自动安装失败：${err.message}`);
      process.exit(1);
    });
}
