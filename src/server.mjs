// src/server.mjs
import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import fs from 'fs/promises';
import fssync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { parseDocumentBuffer, generateAccountDoc } from './docx-tool.mjs';
import { extractUserData, FIELD_KEYS } from './llm-client.mjs';
import {
  initStorage,
  createRecord,
  listRecords,
  getRecord,
  deleteRecord,
  getUploadPath,
  getRecordDir
} from './storage.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// ------------------------------------------------------------
// 配置
// ------------------------------------------------------------
const config = {
  port: Number(process.env.PORT || 3000),
  baseURL: process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  apiKey:  process.env.LLM_API_KEY  || process.env.OPENAI_API_KEY || '',
  model:   process.env.LLM_MODEL    || process.env.OPENAI_MODEL    || 'gpt-4o-mini',
  templatePath: process.env.TEMPLATE_PATH
    ? path.resolve(process.env.TEMPLATE_PATH)
    : path.join(projectRoot, 'templates', 'default.docx'),
  hasTemplate: false
};

async function initConfig() {
  await initStorage();
  config.hasTemplate = fssync.existsSync(config.templatePath);
  if (!config.apiKey) {
    console.warn('⚠️  未配置 LLM_API_KEY，上传解析将会失败。');
  }
  if (!config.hasTemplate) {
    console.warn(`⚠️  未找到模板：${config.templatePath}（DOCX 生成功能将不可用）`);
  }
}

// ------------------------------------------------------------
// Hono
// ------------------------------------------------------------
const app = new Hono();

// ---- 静态资源（前端页面） ----
app.use('/static/*', serveStatic({ root: './public' }));
app.get('/', async (c) => {
  const html = await fs.readFile(path.join(projectRoot, 'public', 'index.html'), 'utf8');
  return c.html(html);
});

// ---- 配置信息（供前端展示） ----
app.get('/api/config', (c) => c.json({
  model: config.model,
  baseURL: config.baseURL,
  hasApiKey: Boolean(config.apiKey),
  hasTemplate: config.hasTemplate,
  fields: FIELDS_SCHEMA_KEYS
}));
const FIELDS_SCHEMA_KEYS = FIELD_KEYS;

// ------------------------------------------------------------
// 1) 上传 -> 解析 -> LLM -> 写缓存
// ------------------------------------------------------------
app.post('/api/upload', async (c) => {
  if (!config.apiKey) return c.json({ error: '服务器未配置 LLM_API_KEY' }, 500);

  const formData = await c.req.formData();
  const rawFiles = formData.getAll('files').filter(f => f && typeof f === 'object' && 'arrayBuffer' in f);
  if (rawFiles.length === 0) return c.json({ error: '未收到任何文件' }, 400);

  // 读取为 Buffer
  const files = [];
  for (const f of rawFiles) {
    const ab = await f.arrayBuffer();
    files.push({
      name: f.name || `file-${files.length}`,
      type: f.type || '',
      buffer: Buffer.from(ab)
    });
  }

  // 解析
  let documents;
  try {
    documents = await Promise.all(files.map(f => parseDocumentBuffer(f.name, f.buffer)));
  } catch (err) {
    return c.json({ error: `文档解析失败：${err.message}` }, 400);
  }

  // 调用大模型
  let userData;
  try {
    userData = await extractUserData({
      documents,
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      model: config.model
    });
  } catch (err) {
    return c.json({ error: `大模型请求失败：${err.message}` }, 502);
  }

  // 写缓存
  const record = await createRecord({
    files,
    userData,
    llm: { baseURL: config.baseURL, model: config.model }
  });

  return c.json({ record });
});

// ------------------------------------------------------------
// 2) 缓存记录列表 / 详情 / 删除
// ------------------------------------------------------------
app.get('/api/records', async (c) => {
  const records = await listRecords();
  return c.json({ records });
});

app.get('/api/records/:id', async (c) => {
  try {
    return c.json({ record: await getRecord(c.req.param('id')) });
  } catch {
    return c.json({ error: '记录不存在' }, 404);
  }
});

app.delete('/api/records/:id', async (c) => {
  try {
    await deleteRecord(c.req.param('id'));
    return c.json({ ok: true });
  } catch {
    return c.json({ error: '删除失败' }, 500);
  }
});

// ------------------------------------------------------------
// 3) 下载：userData / 原始文件 / 生成的 DOCX
// ------------------------------------------------------------
app.get('/api/records/:id/userdata', async (c) => {
  const id = c.req.param('id');
  const record = await getRecord(id).catch(() => null);
  if (!record) return c.json({ error: '记录不存在' }, 404);

  c.header('Content-Type', 'application/json; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="userData-${id}.json"`);
  return c.body(JSON.stringify(record.userData, null, 2));
});

app.get('/api/records/:id/files/:name', async (c) => {
  const id = c.req.param('id');
  const name = c.req.param('name');
  const filePath = getUploadPath(id, name);
  try {
    const buf = await fs.readFile(filePath);
    return new Response(buf, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}"`
      }
    });
  } catch {
    return c.json({ error: '文件不存在' }, 404);
  }
});

app.get('/api/records/:id/docx', async (c) => {
  const id = c.req.param('id');
  if (!config.hasTemplate) return c.json({ error: '服务器未配置模板 DOCX' }, 500);

  const record = await getRecord(id).catch(() => null);
  if (!record) return c.json({ error: '记录不存在' }, 404);

  const outPath = path.join(getRecordDir(id), 'generated.docx');
  try {
    generateAccountDoc(config.templatePath, outPath, record.userData);
    const buf = await fs.readFile(outPath);
    return new Response(buf, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="Account-${id}.docx"`
      }
    });
  } catch (err) {
    return c.json({ error: `生成失败：${err.message}` }, 500);
  }
});

// ------------------------------------------------------------
// 启动
// ------------------------------------------------------------
await initConfig();

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`\n🚀 服务已启动：http://localhost:${info.port}`);
  console.log(`   LLM    : ${config.baseURL}  [${config.model}]`);
  console.log(`   模板    : ${config.hasTemplate ? config.templatePath : '（未配置）'}`);
  console.log(`   缓存目录: ./cache\n`);
});