// Rule schema and validator for user-defined automations.
// A rule is a small structured JSON object that the executor can run deterministically.

const OPERATIONS = ['sum', 'avg', 'count', 'min', 'max'];
const DIRECTIONS = ['row', 'column'];
const SCOPES = ['subitem', 'task'];
const TYPES = ['aggregate'];

function validateRule(rule, columnsCatalog) {
  const errors = [];
  if (!rule || typeof rule !== 'object') return ['Regra vazia ou inválida'];

  if (!TYPES.includes(rule.type)) errors.push(`type deve ser um de: ${TYPES.join(', ')}`);
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

  // coherence: direction=column implies scope of the children being aggregated
  // we expect scope='subitem' when direction='column' (task aggregates its subitem children)
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

function ruleJsonSchema() {
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
    },
    required: ['type', 'operation', 'direction', 'scope', 'sourceColumns', 'targetColumn'],
  };
}

module.exports = { validateRule, ruleJsonSchema, OPERATIONS, DIRECTIONS, SCOPES, TYPES };
