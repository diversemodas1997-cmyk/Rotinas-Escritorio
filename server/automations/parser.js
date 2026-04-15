// Gemini-based parser: natural language description -> structured rule JSON.
// Called ONCE at automation creation time, not at execution.

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { ruleJsonSchema, validateRule } = require('./schema');

const MODEL = 'gemini-2.0-flash';

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
    const result = await model.generateContent(prompt);
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
    const r = await model.generateContent('Responda apenas: OK');
    return { ok: true, model: MODEL, response: r.response.text().slice(0, 80) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { parseAutomation, healthCheck };
