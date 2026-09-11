// src/llm-client.mjs
// ============================================================
// 只负责：把已解析好的文档送给大模型 → 返回严格字段的 userData
// ============================================================
import OpenAI from 'openai';

export const FIELDS_SCHEMA = {
  date:             '文档日期（统一输出 YYYY-MM-DD 格式）',
  accountNumber:    '银行账户号码（纯数字，不含空格或其他分隔符，保留完整数字，不要省略前导 0）',
  iban:             'IBAN 国际银行账户号码（不含空格或其他分隔符，例如 BH75SGBD79456800000030）',
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
4. 若文档中存在"黄色高亮"文本，优先作为字段值的来源。
5. 多份文档冲突时，以最后一份文档为准。
6. 数字类字段保留完整原始格式。
7. address 不要做拼写纠正，原样输出。
8. accountNumber 和 iban 必须去掉所有空格、制表符、换行等分隔符，输出连续字符串。

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
 * 从已解析的文档中提取结构化 userData
 * @param {Object} opts
 * @param {{name:string,text:string,highlights?:string[]}[]} opts.documents
 * @param {string} [opts.baseURL]
 * @param {string}  opts.apiKey
 * @param {string}  opts.model
 * @returns {Promise<Object>}
 */
export async function extractUserData({ documents, baseURL, apiKey, model }) {
  if (!Array.isArray(documents) || documents.length === 0) throw new Error('documents 不能为空');
  if (!apiKey) throw new Error('缺少 apiKey');
  if (!model)  throw new Error('缺少 model');

  const client = new OpenAI({
    baseURL: baseURL || 'https://api.openai.com/v1',
    apiKey,
    // 某些网关（如本项目的 qwen-local）前面的 Cloudflare WAF 会封 openai-node 默认的
    // "OpenAI/NodeJS/..." User-Agent，直接返回 403 Your request was blocked.
    // 这里覆盖为中性 UA；可用 LLM_USER_AGENT 自定义。
    defaultHeaders: {
      'User-Agent': process.env.LLM_USER_AGENT || 'sgb-generator/1.0'
    }
  });

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user',   content: buildUserPrompt(documents) }
  ];

  // 针对 gemma-4-E4B 的采样参数（换成 GPT-4o / DeepSeek / 通义时把这几个参数恢复为 temperature: 0 即可）
  const tuning = {
    temperature: 1.0,
    top_p: 0.95,
    extra_body: { enable_thinking: false }
  };

  let raw;
  try {
    const resp = await client.chat.completions.create({
      model,
      messages,
      response_format: { type: 'json_object' },
      ...tuning
    });
    raw = safeJsonParse(resp.choices[0].message.content);
  } catch (err) {
    console.warn('⚠️ JSON 模式不可用，回退普通调用：', err.message);
    const resp = await client.chat.completions.create({
      model,
      messages,
      ...tuning
    });
    raw = safeJsonParse(resp.choices[0].message.content);
  }

  // 严格按 FIELD_KEYS 顺序 + 白名单过滤
  const userData = {};
  for (const key of FIELD_KEYS) userData[key] = raw[key] ?? null;

  // 兜底：即使模型仍返回带空格的账号/IBAN，也去掉所有空白字符
  for (const key of ['accountNumber', 'iban']) {
    if (typeof userData[key] === 'string') userData[key] = userData[key].replace(/\s+/g, '');
  }
  return userData;
}