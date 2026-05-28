// Gemini-based parser: natural language description -> structured rule JSON.
// Called ONCE at automation creation time, not at execution.

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { ruleJsonSchema, validateRule } = require('./schema');

const MODEL = 'gemini-2.0-flash';

// Free-tier limits for gemini-2.0-flash are 15 RPM / 200 RPD per project.
// We keep local guard rails a bit below to absorb burstiness.
const RPM_LIMIT = 13;
const RPD_LIMIT = 180;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;

const _callTimestamps = [];
let _dailyExhaustedUntil = 0;
let _minuteExhaustedUntil = 0;

// Próxima meia-noite no fuso do Pacífico em ms desde epoch.
// Aproximação: PDT=UTC-7 / PST=UTC-8. Usamos -8 (mais conservador: faz o
// cooldown durar um pouco mais do que o necessário em vez de menos).
function nextPacificMidnightMs(now) {
  const PT_OFFSET_HOURS = 8;
  const ptNow = now - PT_OFFSET_HOURS * 3600 * 1000;
  const d = new Date(ptNow);
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime() + PT_OFFSET_HOURS * 3600 * 1000;
}

function pruneOldTimestamps(now) {
  const cutoff = now - 24 * 60 * 60 * 1000;
  while (_callTimestamps.length && _callTimestamps[0] < cutoff) _callTimestamps.shift();
}

function checkLocalQuota(now) {
  pruneOldTimestamps(now);
  const oneMinAgo = now - 60 * 1000;
  let rpmCount = 0;
  let oldestInWindow = null;
  for (const t of _callTimestamps) {
    if (t >= oneMinAgo) {
      rpmCount++;
      if (oldestInWindow === null) oldestInWindow = t;
    }
  }
  if (rpmCount >= RPM_LIMIT) {
    const waitMs = (oldestInWindow + 60 * 1000) - now;
    return { ok: false, reason: 'rpm', waitMs: Math.max(waitMs, 1000) };
  }
  if (_callTimestamps.length >= RPD_LIMIT) {
    return { ok: false, reason: 'rpd' };
  }
  return { ok: true };
}

function extractRetryDelayMs(err) {
  const details = err?.errorDetails || err?.cause?.errorDetails;
  if (Array.isArray(details)) {
    for (const d of details) {
      if (typeof d?.['@type'] === 'string' && d['@type'].includes('RetryInfo')) {
        const m = String(d.retryDelay || '').match(/^(\d+(?:\.\d+)?)s$/);
        if (m) return Math.ceil(parseFloat(m[1]) * 1000);
      }
    }
  }
  const msg = err?.message || '';
  const m = msg.match(/retryDelay["':\s]+(\d+(?:\.\d+)?)s/);
  if (m) return Math.ceil(parseFloat(m[1]) * 1000);
  return null;
}

function isQuotaError(err) {
  if (err?.status === 429) return true;
  const msg = err?.message || '';
  return /\b429\b|RESOURCE_EXHAUSTED|quota/i.test(msg);
}

function classifyQuotaError(err) {
  const blob = JSON.stringify(err?.errorDetails || err?.cause?.errorDetails || '') + ' ' + (err?.message || '');
  if (/PerDayPer/i.test(blob)) return 'daily';
  if (/PerMinute|PerModelPerMinute/i.test(blob)) return 'minute';
  return 'unknown';
}

async function callGemini(model, prompt) {
  const now = Date.now();
  if (now < _dailyExhaustedUntil) {
    const mins = Math.ceil((_dailyExhaustedUntil - now) / 60000);
    const e = new Error(`Cota DIÁRIA do Gemini esgotada (detectada pela API). O contador zera em ~${mins} min (meia-noite no Pacífico).`);
    e.code = 'GEMINI_DAILY_COOLDOWN';
    throw e;
  }
  if (now < _minuteExhaustedUntil) {
    const sec = Math.ceil((_minuteExhaustedUntil - now) / 1000);
    const e = new Error(`Cota POR MINUTO do Gemini esgotada. Aguarde ${sec}s.`);
    e.code = 'GEMINI_MINUTE_COOLDOWN';
    throw e;
  }
  const q = checkLocalQuota(now);
  if (!q.ok) {
    if (q.reason === 'rpm') {
      const sec = Math.ceil(q.waitMs / 1000);
      const e = new Error(`Limite local de ${RPM_LIMIT} req/min do Gemini atingido. Aguarde ~${sec}s e tente novamente.`);
      e.code = 'LOCAL_RPM';
      throw e;
    }
    const e = new Error(`Limite local diário de ${RPD_LIMIT} requisições ao Gemini atingido. O contador zera após a meia-noite (horário do Pacífico).`);
    e.code = 'LOCAL_RPD';
    throw e;
  }

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      _callTimestamps.push(Date.now());
      return await model.generateContent(prompt);
    } catch (e) {
      lastErr = e;
      if (!isQuotaError(e)) throw e;
      if (attempt === MAX_RETRIES) break;
      const apiDelay = extractRetryDelayMs(e);
      const expBackoff = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
      const waitMs = (apiDelay ?? expBackoff) + Math.floor(Math.random() * 500);
      console.warn(`[gemini] 429 quota (tentativa ${attempt + 1}/${MAX_RETRIES}). Aguardando ${waitMs}ms${apiDelay ? ' (retryDelay da API)' : ' (backoff exponencial)'}.`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
  const kind = classifyQuotaError(lastErr);
  let msg;
  if (kind === 'daily') {
    _dailyExhaustedUntil = nextPacificMidnightMs(Date.now());
    const mins = Math.ceil((_dailyExhaustedUntil - Date.now()) / 60000);
    msg = `Cota DIÁRIA do Gemini free tier (~200 req/dia por projeto) esgotada. O contador zera em ~${mins} min (meia-noite no Pacífico, ≈04h BRT). Habilite billing no Google Cloud para aumentar o limite.`;
  } else if (kind === 'minute') {
    const apiDelay = extractRetryDelayMs(lastErr) ?? 60_000;
    _minuteExhaustedUntil = Date.now() + apiDelay;
    msg = `Cota POR MINUTO do Gemini free tier (15 req/min) atingida. Aguarde ${Math.ceil(apiDelay / 1000)}s e tente de novo.`;
  } else {
    msg = `Cota do Gemini esgotada (após ${MAX_RETRIES} tentativas com retry).`;
  }
  const friendly = new Error(msg);
  friendly.code = 'GEMINI_QUOTA';
  friendly.cause = lastErr;
  throw friendly;
}

function buildPrompt(description, columns) {
  const catalog = columns.map(c => ({
    id: c.id,
    name: c.name,
    type: c.type,
    scope: c.scope || 'task',
    parentColumnId: c.parent_column_id || c.parentColumnId || null,
    taskId: c.task_id || c.taskId || null,
  }));

  return `Você é um compilador de automações para um quadro tipo Monday.com.
Traduza a descrição do usuário (em português) para UMA regra JSON estruturada.

Schema da regra:
- type: "aggregate" (único tipo suportado hoje)
- operation: "sum" | "avg" | "count" | "min" | "max"
- direction:
    - "row": para cada LINHA, agrega as colunas source da mesma linha e grava na coluna target da mesma linha
    - "column": para cada TASK, agrega os subitems filhos (soma vertical) e grava na coluna target da task pai
- scope: "subitem" | "task" — o escopo das linhas iteradas (ou dos filhos se direction=column)
- sourceColumns: array de IDs de colunas (use os IDs exatos do catálogo abaixo)
- targetColumn: ID da coluna destino
- taskId: null para aplicar a todas as tasks, ou um ID específico de task quando a coluna destino é uma subcoluna per-task

Regras de resolução:
1. Os nomes de colunas na descrição podem estar em maiúsculas/minúsculas diferentes — faça match case-insensitive.
2. "pedidos" normalmente se refere a colunas de tipo number relacionadas a vendas/canais.
3. "cada linha dos subitem" ou "cada subitem" → scope="subitem", direction="row".
4. "para cada task somar os subitems" → scope="subitem", direction="column".
5. Se a coluna destino for uma subcoluna (parentColumnId != null), e pertencer a uma task específica (taskId != null), defina o taskId na regra.
6. Nunca inclua a targetColumn dentro de sourceColumns.

Catálogo de colunas disponíveis:
${JSON.stringify(catalog, null, 2)}

Descrição do usuário:
"""${description}"""

Responda APENAS com o JSON da regra, sem texto adicional.`;
}

async function parseAutomation({ description, columns }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY não configurada no servidor');
  }
  if (!description || description.trim().length < 10) {
    throw new Error('Descrição muito curta — detalhe o que a automação deve fazer');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: MODEL,
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: ruleJsonSchema(),
    },
  });

  const prompt = buildPrompt(description, columns);
  let text;
  try {
    const result = await callGemini(model, prompt);
    text = result.response.text();
  } catch (e) {
    console.error('[parser] Gemini API call failed:', e.stack || e.message);
    throw new Error(`Falha na chamada Gemini: ${e.message}`);
  }

  let rule;
  try {
    rule = JSON.parse(text);
  } catch (e) {
    console.error('[parser] JSON parse failed. Raw response:', text);
    throw new Error(`Falha ao interpretar resposta da IA: ${e.message}`);
  }

  if (rule.taskId === '' || rule.taskId === undefined) rule.taskId = null;

  const errors = validateRule(rule, columns);
  if (errors.length) {
    console.error('[parser] Rule validation failed. Rule:', JSON.stringify(rule), 'errors:', errors);
    throw new Error(`Regra inválida: ${errors.join('; ')}`);
  }

  return rule;
}

async function healthCheck() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { ok: false, error: 'GEMINI_API_KEY ausente no ambiente' };
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: MODEL });
    const r = await callGemini(model, 'Responda apenas: OK');
    return { ok: true, model: MODEL, response: r.response.text().slice(0, 80) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function quotaStatus() {
  const now = Date.now();
  pruneOldTimestamps(now);
  const oneMinAgo = now - 60 * 1000;
  const rpm = _callTimestamps.filter(t => t >= oneMinAgo).length;
  return {
    rpm, rpmLimit: RPM_LIMIT,
    rpd: _callTimestamps.length, rpdLimit: RPD_LIMIT,
    dailyCooldownMinLeft: now < _dailyExhaustedUntil ? Math.ceil((_dailyExhaustedUntil - now) / 60000) : 0,
    minuteCooldownSecLeft: now < _minuteExhaustedUntil ? Math.ceil((_minuteExhaustedUntil - now) / 1000) : 0,
  };
}

module.exports = { parseAutomation, healthCheck, quotaStatus };
