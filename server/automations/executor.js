const { validateRule } = require('./schema');

const NATIVE_FIELD_MAP = {
  totalOrders: 'total_orders',
  totalCancellations: 'total_cancellations',
  total: 'total',
};

function isCancelColumn(col) {
  return col.parentColumnId === 'col_cancel' ||
    /cancel/i.test(col.field) ||
    /cancelamento/i.test(col.name);
}

function readNumericValue(row, column) {
  if (column.field && NATIVE_FIELD_MAP[column.field] && row[NATIVE_FIELD_MAP[column.field]] !== undefined) {
    const v = Number(row[NATIVE_FIELD_MAP[column.field]]);
    return Number.isFinite(v) ? v : null;
  }
  let custom = {};
  try { custom = typeof row.custom === 'string' ? JSON.parse(row.custom || '{}') : (row.custom || {}); } catch { custom = {}; }
  const v = custom[column.field] ?? custom[column.id];
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function writeCustomValue(row, column, value) {
  let custom = {};
  try { custom = typeof row.custom === 'string' ? JSON.parse(row.custom || '{}') : (row.custom || {}); } catch { custom = {}; }
  custom[column.field || column.id] = value;
  return JSON.stringify(custom);
}

function apply(op, values) {
  const nums = values.filter(v => v !== null && Number.isFinite(v));
  if (nums.length === 0) return null;
  switch (op) {
    case 'sum': return nums.reduce((a, b) => a + b, 0);
    case 'avg': return nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'count': return nums.length;
    case 'min': return Math.min(...nums);
    case 'max': return Math.max(...nums);
    default: throw new Error(`operação desconhecida: ${op}`);
  }
}

function execute({ db, rule }) {
  const columns = db.prepare('SELECT * FROM columns_config').all().map(c => ({
    id: c.id, name: c.name, type: c.type, field: c.field,
    scope: c.scope || 'task', parentColumnId: c.parent_column_id, taskId: c.task_id,
  }));

  const errors = validateRule(rule, columns);
  if (errors.length) return { applied: 0, summary: '', errors };

  const byId = new Map(columns.map(c => [c.id, c]));
  const targetCol = byId.get(rule.targetColumn);
  let sourceCols;
  if (rule.autoDiscoverSource) {
    sourceCols = columns.filter(c =>
      c.scope === 'subitem' &&
      c.taskId === rule.taskId &&
      c.type === 'number' &&
      c.id !== rule.targetColumn &&
      !isCancelColumn(c)
    );
    if (sourceCols.length === 0) {
      return { applied: 0, summary: '', errors: [`Nenhuma subcoluna numérica encontrada para a task ${rule.taskId}`] };
    }
  } else {
    sourceCols = rule.sourceColumns.map(id => byId.get(id));
  }

  let applied = 0;
  const updSub = db.prepare('UPDATE subitems SET custom=? WHERE id=?');
  const updTask = db.prepare('UPDATE tasks SET custom=?, updated_at=CURRENT_TIMESTAMP WHERE id=?');

  const tx = db.transaction(() => {
    if (rule.direction === 'row' && rule.scope === 'subitem') {
      const rows = rule.taskId
        ? db.prepare('SELECT * FROM subitems WHERE task_id=?').all(rule.taskId)
        : db.prepare('SELECT * FROM subitems').all();
      for (const row of rows) {
        const vals = sourceCols.map(c => readNumericValue(row, c));
        const result = apply(rule.operation, vals);
        if (result === null) continue;
        const newCustom = writeCustomValue(row, targetCol, result);
        updSub.run(newCustom, row.id);
        applied++;
      }
    } else if (rule.direction === 'row' && rule.scope === 'task') {
      const rows = rule.taskId
        ? db.prepare('SELECT * FROM tasks WHERE id=?').all(rule.taskId)
        : db.prepare('SELECT * FROM tasks').all();
      for (const row of rows) {
        const vals = sourceCols.map(c => readNumericValue(row, c));
        const result = apply(rule.operation, vals);
        if (result === null) continue;
        const newCustom = writeCustomValue(row, targetCol, result);
        updTask.run(newCustom, row.id);
        applied++;
      }
    } else if (rule.direction === 'column' && rule.scope === 'subitem') {
      const tasks = rule.taskId
        ? db.prepare('SELECT * FROM tasks WHERE id=?').all(rule.taskId)
        : db.prepare('SELECT * FROM tasks').all();
      const getSubs = db.prepare('SELECT * FROM subitems WHERE task_id=?');
      for (const task of tasks) {
        const subs = getSubs.all(task.id);
        const vals = [];
        for (const s of subs) {
          for (const c of sourceCols) {
            const v = readNumericValue(s, c);
            if (v !== null) vals.push(v);
          }
        }
        const result = apply(rule.operation, vals);
        if (result === null) continue;
        const newCustom = writeCustomValue(task, targetCol, result);
        updTask.run(newCustom, task.id);
        applied++;
      }
    }
  });

  try {
    tx();
  } catch (e) {
    return { applied: 0, summary: '', errors: [`Erro ao executar: ${e.message}`] };
  }

  const summary = `${applied} linha(s) atualizada(s) na coluna "${targetCol.name}" usando ${rule.operation} sobre ${rule.sourceColumns.length} coluna(s) de origem`;
  return { applied, summary, errors: [] };
}

module.exports = { execute };
