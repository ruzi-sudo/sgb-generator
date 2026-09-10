// src/llm-client.mjs
// ============================================================
// 只负责：把已解析好的文档送给大模型 → 拿到严格字段的 userData
// ============================================================
import OpenAI from 'openai';

export const FIELDS_SCHEMA = {
  date:             '文档日期（统一输出 YYYY-MM-DD 格式）',
  accountNumber:    '银行账户号码（保留完整数字，不要省略前导 0）',
  iban:             'IBAN 国际银行账户号码（例如 BH75SGBD79456800000030）',
  currency:         '货币类型，3 位大写字母代码（如 USD / EUR / CNY）',
  recipientName:    '收款人姓名（通常全大写，与文档保持一致）',
  recipientAddress: '收款人地址（保留文档中原始写法，含门牌、城市、邮编、国家）'
};

export const FIELD_KEYS = Object.keys(FIELDS_SCHEMA);

const SYSTEM_PROMPT = `你是一位专业的银行文档信息提取专家。用户会提供一份或多份文档（DOCX 或 PDF）的文本内容。
你的任务：从这些文档中严格识别并提取以下字段：

${FIELD_KEYS.map(k => `- ${k}: ${FIELDS_SCHEMA[k]}`).join('\n')}

【严格规则】
1. 输出必须是合法 JSON 对象，键名严格使用上述 6 个英文键，不得新增/改名/遗漏。
2. 找不到的字段值设为 null。
3. 不要输出任何解释、注释、markdown 代码块，只输出纯 JSON。
4. 文档中若有"黄色高亮"文本，优先作为字段值的来源。
5. 多份文档冲突时，以最后一份文档为准。
6. 数字类字段保留完整原始格式。
7. 地址不要做拼写纠正，原样输出。

【输出示例】
{"date":"2025-03-14","accountNumber":"79456800000030","iban":"BH75SGBD79456800000030","currency":"USD","recipientName":"FU FANGRONG","recipientAddress":"24HAO DIERNONG..."}`;

function buildUserPrompt(documents) {
  return documents.map((doc, i) => {
    let s = `===== 文档 ${i + 1}: ${doc.name} =====\n${doc.text}`;
    if (doc.highlights?.length) {
      s += `\n\n【该文档中的黄色高亮文本（优先作为字段值来源）】\n` +
        doc.highlights.map(h => `- ${h}`).join('\n');
    }
    return s;
  }).join('\n\n');
}

function safeJsonParse(str) {
  let s = (str || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(s);
}

/**
 * @param {Object} opts
 * @param {{name:string,text:string,highlights?:string[]}[]} opts.documents
 * @param {string} [opts.baseURL]
 * @param {string}  opts.apiKey
 * @param {string}  opts.model
 * @returns {Promise<Object>} 严格按 FIELD_KEYS 顺序的 userData
 */
export async function extractUserData({ documents, baseURL, apiKey, model }) {
  if (!Array.isArray(documents) || documents.length === 0) throw new Error('documents 不能为空');
  if (!apiKey) throw new Error('缺少 apiKey');
  if (!model)  throw new Error('缺少 model');

  const client = new OpenAI({
    baseURL: baseURL || 'https://api.openai.com/v1',
    apiKey
  });

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user',   content: buildUserPrompt(documents) }
  ];

  let raw;
  try {
    const resp = await client.chat.completions.create({
      model,
      messages,
      response_format: { type: 'json_object' },
      temperature: 0
    });
    raw = safeJsonParse(resp.choices[0].message.content);
  } catch (err) {
    console.warn('⚠️ JSON 模式不可用，回退普通调用：', err.message);
    const resp = await client.chat.completions.create({
      model, messages, temperature: 0
    });
    raw = safeJsonParse(resp.choices[0].message.content);
  }

  const userData = {};
  for (const key of FIELD_KEYS) userData[key] = raw[key] ?? null;
  return userData;
}