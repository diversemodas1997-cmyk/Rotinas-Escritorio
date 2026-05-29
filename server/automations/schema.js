// Rule schema and validator for user-defined automations.
// A rule is a small structured JSON object that the executor can run deterministically.

const OPERATIONS = ['sum', 'avg', 'count', 'min', 'max'];
const DIRECTIONS = ['row', 'column'];
const SCOPES = ['subitem', 'task'];
const TYPES = ['aggregate', 'notify'];
const NOTIFY_TRIGGERS = ['deadline_today', 'deadline_overdue'];

function validateRule(rule, columnsCatalog) {
  if (!rule || typeof rule !== 'object') return ['Regra vazia ou inválida'];
  if (!TYPES.includes(rule.type)) return [`type deve ser um de: ${TYPES.join(', ')}`];
  if (rule.type === 'notify') return validateNotifyRule(rule, columnsCatalog);
  return validateAggregateRule(rule, columnsCatalog);
}

function validateAggregateRule(rule, columnsCatalog) {
  const errors = [];
  if (!OPERATIONS.includes(rule.operation)) errors.push(`operation deve ser um de: ${OPERATIONS.join(', ')}`);
  if (!DIRECTIONS.includes(rule.direction)) errors.push(`direction deve ser um de: ${DIRECTIONS.join(', ')}`);
  if (!SCOPES.includes(rule.scope)) errors.push(`scope deve ser um de: ${SCOPES.join(', ')}`);
  const autoDiscover = rule.autoDiscoverSource === true;
  if (!autoDiscover && (!Array.isArray(rule.sourceColumns) || rule.sourceColumns.length === 0)) errors.push('sourceColumns deve ser um array não-vazio');
  if (!rule.targetColumn || typeof rule.targetColumn !== 'string') errors.push('targetColumn obrigatório');
  if (rule.taskId !== null && rule.taskId !== undefined && typeof rule.taskId !== 'string') errors.push('taskId deve ser string ou null');
  if (autoDiscover && !rule.taskId) errors.push('autoDiscoverSource requer taskId');

  if (errors.length) return errors;

  const byId = new Map(columnsCatalog.map(c => [c.id, c]));
  const idsToCheck = autoDiscover ? [rule.targetColumn] : [...rule.sourceColumns, rule.targetColumn];
  for (const id of idsToCheck) {
    if (!byId.has(id)) errors.push(`coluna "${id}" não existe no quadro`);
  }
  if (!autoDiscover && rule.sourceColumns.includes(rule.targetColumn)) {
    errors.push('targetColumn não pode estar em sourceColumns');
  }

  if (rule.direction === 'column' && rule.scope !== 'subitem') {
    errors.push('direction=column requer scope=subitem (agrega filhos subitem em uma task pai)');
  }

  if (errors.length === 0 && !autoDiscover) {
    for (const id of rule.sourceColumns) {
      const c = byId.get(id);
      if (c && c.type && c.type !== 'number') {
        errors.push(`coluna "${c.name}" não é do tipo number (tipo atual: ${c.type})`);
      }
    }
  }

  return errors;
}

function validateNotifyRule(rule, columnsCatalog) {
  // Variante "specific": alvo (tarefa/subitem) + data absoluta, criada pelo formato guiado.
  if (rule.mode === 'specific') return validateNotifySpecificRule(rule);
  const errors = [];
  if (!NOTIFY_TRIGGERS.includes(rule.trigger)) errors.push(`trigger deve ser um de: ${NOTIFY_TRIGGERS.join(', ')}`);
  if (!SCOPES.includes(rule.scope)) errors.push(`scope deve ser um de: ${SCOPES.join(', ')}`);
  if (!rule.dateColumn || typeof rule.dateColumn !== 'string') errors.push('dateColumn obrigatório (id da coluna de data)');
  if (!Array.isArray(rule.recipients) || rule.recipients.length === 0) errors.push('recipients deve ser array não-vazio com nomes de usuários');
  if (!rule.message || typeof rule.message !== 'string' || rule.message.trim().length < 1) errors.push('message obrigatório');
  if (rule.taskNamePattern !== undefined && rule.taskNamePattern !== null && typeof rule.taskNamePattern !== 'string') {
    errors.push('taskNamePattern deve ser string ou null');
  }

  if (errors.length) return errors;

  const byId = new Map(columnsCatalog.map(c => [c.id, c]));
  const col = byId.get(rule.dateColumn);
  if (!col) errors.push(`dateColumn "${rule.dateColumn}" não existe no quadro`);
  else if (col.type !== 'date') errors.push(`dateColumn "${col.name}" deve ser do tipo date (tipo atual: ${col.type})`);

  return errors;
}

function validateNotifySpecificRule(rule) {
  const errors = [];
  if (!SCOPES.includes(rule.targetType)) errors.push(`targetType deve ser um de: ${SCOPES.join(', ')}`);
  if (!rule.targetId || typeof rule.targetId !== 'string') errors.push('targetId obrigatório (id da tarefa/subitem)');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rule.date || '')) errors.push('date deve estar no formato YYYY-MM-DD');
  if (!Array.isArray(rule.recipients) || rule.recipients.length === 0) errors.push('recipients deve ser array não-vazio com nomes de usuários');
  if (!rule.message || typeof rule.message !== 'string' || rule.message.trim().length < 1) errors.push('message obrigatório');
  return errors;
}

function ruleJsonSchema() {
  // Schema permissivo: campos específicos de cada tipo são opcionais aqui;
  // o validador acima impõe os requisitos por type. Necessário porque o
  // responseSchema do Gemini não suporta oneOf nativamente.
  return {
    type: 'object',
    properties: {
      type: { type: 'string', enum: TYPES },
      operation: { type: 'string', enum: OPERATIONS },
      direction: { type: 'string', enum: DIRECTIONS },
      scope: { type: 'string', enum: SCOPES },
      sourceColumns: { type: 'array', items: { type: 'string' } },
      targetColumn: { type: 'string' },
      taskId: { type: 'string' },
      trigger: { type: 'string', enum: NOTIFY_TRIGGERS },
      dateColumn: { type: 'string' },
      taskNamePattern: { type: 'string' },
      recipients: { type: 'array', items: { type: 'string' } },
      message: { type: 'string' },
    },
    required: ['type'],
  };
}

module.exports = { validateRule, ruleJsonSchema, OPERATIONS, DIRECTIONS, SCOPES, TYPES, NOTIFY_TRIGGERS };
