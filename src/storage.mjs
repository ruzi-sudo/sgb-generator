// src/storage.mjs
// ============================================================
// 缓存记录以「每条记录一个文件夹」的形式存放到 CACHE_DIR
// 结构：
//   cache/
//     <id>/
//       meta.json              # { id, createdAt, files, userData, llm }
//       uploads/               # 原始上传文件副本
//       generated.docx         # 生成后的文档（下载时才写）
// ============================================================
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const CACHE_DIR = path.resolve(process.env.CACHE_DIR || './cache');

export async function initStorage() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
}

function genId() {
  return crypto.randomBytes(8).toString('hex');
}

function recordDir(id) {
  if (!/^[a-f0-9]{16}$/.test(id)) throw new Error('非法的记录 ID');
  return path.join(CACHE_DIR, id);
}

export function getRecordDir(id) {
  return recordDir(id);
}

export function getUploadPath(id, name) {
  return path.join(recordDir(id), 'uploads', path.basename(name));
}

export async function createRecord({ files, userData, llm }) {
  const id = genId();
  const dir = path.join(CACHE_DIR, id);
  await fs.mkdir(path.join(dir, 'uploads'), { recursive: true });

  const fileMetas = [];
  for (const f of files) {
    const safeName = path.basename(f.name);
    const dest = path.join(dir, 'uploads', safeName);
    await fs.writeFile(dest, f.buffer);
    fileMetas.push({ name: safeName, size: f.buffer.length, type: f.type || '' });
  }

  const meta = {
    id,
    createdAt: new Date().toISOString(),
    files: fileMetas,
    userData,
    llm
  };

  await fs.writeFile(
    path.join(dir, 'meta.json'),
    JSON.stringify(meta, null, 2),
    'utf8'
  );
  return meta;
}

export async function listRecords() {
  const entries = await fs.readdir(CACHE_DIR, { withFileTypes: true });
  const records = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const raw = await fs.readFile(path.join(CACHE_DIR, e.name, 'meta.json'), 'utf8');
      records.push(JSON.parse(raw));
    } catch {
      // 忽略损坏的记录
    }
  }
  records.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return records;
}

export async function getRecord(id) {
  const raw = await fs.readFile(path.join(recordDir(id), 'meta.json'), 'utf8');
  return JSON.parse(raw);
}

export async function deleteRecord(id) {
  await fs.rm(recordDir(id), { recursive: true, force: true });
}

export { CACHE_DIR };