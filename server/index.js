require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { parseAutomation, healthCheck: geminiHealthCheck, quotaStatus: geminiQuotaStatus } = require('./automations/parser');
const { execute: executeAutomation } = require('./automations/executor');
const { validateRule } = require('./automations/schema');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'rotina-escritorio-secret-2026';
const BACKUP_TOKEN = process.env.BACKUP_TOKEN || '';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'database.sqlite');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE, email TEXT,
    password TEXT NOT NULL, role TEXT DEFAULT 'collaborator', phone TEXT DEFAULT '',
    department TEXT DEFAULT '', bio TEXT DEFAULT '', avatar_color TEXT DEFAULT '#888',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS board_folders (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT DEFAULT '📁',
    color TEXT DEFAULT '#778ca3', sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS boards (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT DEFAULT '📋',
    color TEXT DEFAULT '#6c5ce7', sort_order INTEGER DEFAULT 0,
    folder_id TEXT DEFAULT 'folder_operacionais',
    restricted INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT DEFAULT 'Não iniciado',
    priority TEXT DEFAULT 'Média', deadline TEXT, responsible TEXT DEFAULT '[]',
    total_orders INTEGER DEFAULT 0, total_cancellations INTEGER DEFAULT 0,
    custom TEXT DEFAULT '{}', sort_order INTEGER DEFAULT 0,
    board_id TEXT DEFAULT 'board_operacoes',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS subitems (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, name TEXT NOT NULL, owner TEXT DEFAULT '',
    status TEXT DEFAULT 'Não iniciado', responsible TEXT DEFAULT '[]', total INTEGER DEFAULT 0,
    deadline TEXT, custom TEXT DEFAULT '{}', priority TEXT DEFAULT 'Média', sort_order INTEGER DEFAULT 0,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS columns_config (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, field TEXT NOT NULL,
    built_in INTEGER DEFAULT 0, is_deadline INTEGER DEFAULT 0, width TEXT DEFAULT '80px', sort_order INTEGER DEFAULT 0,
    scope TEXT DEFAULT 'task', parent_column_id TEXT, task_id TEXT,
    board_id TEXT DEFAULT 'board_operacoes'
  );
  CREATE TABLE IF NOT EXISTS updates (
    id TEXT PRIMARY KEY, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
    author TEXT NOT NULL, text TEXT DEFAULT '', mentions TEXT DEFAULT '[]',
    files TEXT DEFAULT '[]', created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS automations (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
    icon TEXT DEFAULT '🤖', active INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS daily_snapshots (
    date TEXT NOT NULL, task_id TEXT NOT NULL, subitem_id TEXT,
    column_id TEXT NOT NULL, value REAL DEFAULT 0, responsible TEXT DEFAULT '[]',
    task_name TEXT DEFAULT '', subitem_name TEXT DEFAULT '', column_name TEXT DEFAULT '',
    board_id TEXT,
    PRIMARY KEY (date, task_id, subitem_id, column_id)
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT
  );
  CREATE TABLE IF NOT EXISTS notification_log (
    rule_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
    date_key TEXT NOT NULL, sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (rule_id, target_type, target_id, date_key)
  );
`);

// ===== Usernames =====
// Login identifier: 3-20 chars, letters/digits/dot/underscore/hyphen, case-insensitive.
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,20}$/;
const normalizeUsername = (v) => String(v || '').trim().toLowerCase();
function slugifyUsername(v) {
  // NFD splits accented letters into base + combining mark; the allowlist below
  // drops the marks, so "João" becomes "joao".
  return String(v || '')
    .normalize('NFD')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 20);
}

// Login is by username only (no email). Older databases had `email` as the
// UNIQUE NOT NULL login field, so the table has to be rebuilt to add `username`
// and relax `email` to an optional profile field.
(function migrateUsersUsername() {
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (cols.includes('username')) return;

  const rows = db.prepare('SELECT id, name, email FROM users').all();
  const taken = new Set();
  const assigned = rows.map(r => {
    const local = String(r.email || '').split('@')[0];
    let base = slugifyUsername(local) || slugifyUsername(r.name) || `user${r.id}`;
    if (base.length < 3) base = `${base}${r.id}`;
    let u = base, n = 1;
    while (taken.has(u)) u = `${base}${++n}`;
    taken.add(u);
    return { id: r.id, username: u, name: r.name };
  });

  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE, email TEXT,
        password TEXT NOT NULL, role TEXT DEFAULT 'collaborator', phone TEXT DEFAULT '',
        department TEXT DEFAULT '', bio TEXT DEFAULT '', avatar_color TEXT DEFAULT '#888',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO users_new (id,name,username,email,password,role,phone,department,bio,avatar_color,created_at)
        SELECT id,name,'user_' || id,email,password,role,phone,department,bio,avatar_color,created_at FROM users;
    `);
    const upd = db.prepare('UPDATE users_new SET username=? WHERE id=?');
    assigned.forEach(a => upd.run(a.username, a.id));
    db.exec('DROP TABLE users; ALTER TABLE users_new RENAME TO users;');
  })();
  db.pragma('foreign_keys = ON');

  if (assigned.length) {
    console.log('🔑 Login agora e por nome de usuario. Usuarios migrados:');
    assigned.forEach(a => console.log(`   ${a.name} -> ${a.username}`));
  }
})();

// Acesso explícito a quadro, independente de estar como responsável em tarefa.
// É o que permite adicionar/remover alguém de um quadro sem inventar tarefa.
db.exec(`
  CREATE TABLE IF NOT EXISTS board_members (
    board_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    PRIMARY KEY (board_id, user_id)
  );
`);

// Relatórios são por quadro: cada linha do histórico guarda de qual quadro veio.
// Linhas antigas recebem o quadro da tarefa correspondente; as de tarefa já
// excluída ficam sem quadro e não entram em nenhum relatório filtrado.
(function migrateSnapshotBoard() {
  const cols = db.prepare("PRAGMA table_info(daily_snapshots)").all().map(c => c.name);
  if (cols.length && !cols.includes('board_id')) {
    db.exec("ALTER TABLE daily_snapshots ADD COLUMN board_id TEXT");
    const n = db.prepare(`
      UPDATE daily_snapshots SET board_id = (SELECT board_id FROM tasks WHERE tasks.id = daily_snapshots.task_id)
      WHERE board_id IS NULL
    `).run().changes;
    const orfas = db.prepare("SELECT COUNT(*) c FROM daily_snapshots WHERE board_id IS NULL").get().c;
    console.log(`📊 Relatórios por quadro: ${n} registro(s) migrado(s)${orfas ? `, ${orfas} sem quadro (tarefa excluída)` : ''}`);
  }
})();

// Quadro restrito: só quem está na lista de acesso enxerga, mesmo que seja
// responsável por alguma tarefa dele. Padrão 0 = mantém o comportamento antigo.
(function migrateBoardRestricted() {
  const cols = db.prepare("PRAGMA table_info(boards)").all().map(c => c.name);
  if (cols.length && !cols.includes('restricted')) db.exec("ALTER TABLE boards ADD COLUMN restricted INTEGER DEFAULT 0");
})();

// Non-destructive migration: subitems ganharam prioridade própria (a coluna
// "Prioridade" já era exibida na linha do subitem, mas o valor não era salvo).
(function migrateSubitemPriority() {
  const cols = db.prepare("PRAGMA table_info(subitems)").all().map(c => c.name);
  if (!cols.includes('priority')) db.exec("ALTER TABLE subitems ADD COLUMN priority TEXT DEFAULT 'Média'");
  // Carimbo de alteração: é por ele que a barra lateral conta quantas mudanças
  // cada quadro acumulou desde a última vez que o usuário olhou. Tarefas já
  // tinham updated_at; subitens não.
  // ALTER TABLE não aceita CURRENT_TIMESTAMP como default (não é constante),
  // então a coluna entra sem default e as linhas antigas recebem o agora.
  if (!cols.includes('updated_at')) {
    db.exec("ALTER TABLE subitems ADD COLUMN updated_at DATETIME");
    db.exec("UPDATE subitems SET updated_at=CURRENT_TIMESTAMP WHERE updated_at IS NULL");
  }
})();

// Non-destructive migration: add scope/parent_column_id to existing databases
(function migrateColumnsConfig() {
  const cols = db.prepare("PRAGMA table_info(columns_config)").all().map(c => c.name);
  if (!cols.includes('scope')) db.exec("ALTER TABLE columns_config ADD COLUMN scope TEXT DEFAULT 'task'");
  if (!cols.includes('parent_column_id')) db.exec("ALTER TABLE columns_config ADD COLUMN parent_column_id TEXT");
  if (!cols.includes('task_id')) db.exec("ALTER TABLE columns_config ADD COLUMN task_id TEXT");
  if (!cols.includes('computed')) db.exec("ALTER TABLE columns_config ADD COLUMN computed TEXT");
  // Colunas de horário podem ser marcadas para preenchimento automático pelo
  // status: 'start' grava a hora quando a linha vira "Em andamento", 'end'
  // quando vira "Feito". NULL = coluna de horário comum, preenchida na mão.
  if (!cols.includes('auto_time')) db.exec("ALTER TABLE columns_config ADD COLUMN auto_time TEXT");
  // Qual coluna de status o horário observa. Um quadro pode ter várias (ex.:
  // "Status Arte" e "Status Produção"), então cada horário aponta para a sua.
  // NULL = a coluna Status nativa do quadro.
  if (!cols.includes('auto_time_source')) db.exec("ALTER TABLE columns_config ADD COLUMN auto_time_source TEXT");
  // Clean up orphan subColumns without task_id (created before per-task scoping)
  db.prepare("DELETE FROM columns_config WHERE scope='subitem' AND task_id IS NULL").run();
})();

// Non-destructive migration: introduce multi-board + folders support
(function migrateBoards() {
  const DEFAULT_BOARD_ID = 'board_operacoes';
  const FOLDER_OP = 'folder_operacionais';
  const FOLDER_GE = 'folder_gerenciais';

  const taskCols = db.prepare("PRAGMA table_info(tasks)").all().map(c => c.name);
  if (!taskCols.includes('board_id')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN board_id TEXT DEFAULT '${DEFAULT_BOARD_ID}'`);
  }
  const ccCols = db.prepare("PRAGMA table_info(columns_config)").all().map(c => c.name);
  if (!ccCols.includes('board_id')) {
    db.exec(`ALTER TABLE columns_config ADD COLUMN board_id TEXT DEFAULT '${DEFAULT_BOARD_ID}'`);
  }
  const boardCols = db.prepare("PRAGMA table_info(boards)").all().map(c => c.name);
  if (!boardCols.includes('folder_id')) {
    db.exec(`ALTER TABLE boards ADD COLUMN folder_id TEXT DEFAULT '${FOLDER_OP}'`);
  }

  // Default folders
  if (!db.prepare('SELECT id FROM board_folders WHERE id=?').get(FOLDER_OP)) {
    db.prepare('INSERT INTO board_folders (id,name,icon,color,sort_order) VALUES (?,?,?,?,?)')
      .run(FOLDER_OP, 'Operacionais', '⚙️', '#6c5ce7', 0);
  }
  if (!db.prepare('SELECT id FROM board_folders WHERE id=?').get(FOLDER_GE)) {
    db.prepare('INSERT INTO board_folders (id,name,icon,color,sort_order) VALUES (?,?,?,?,?)')
      .run(FOLDER_GE, 'Gerenciais', '📊', '#00c875', 1);
  }

  // Default board (created on first migration of an existing DB with content)
  const taskCount = db.prepare('SELECT COUNT(*) as c FROM tasks').get().c;
  const colCount = db.prepare('SELECT COUNT(*) as c FROM columns_config').get().c;
  const defaultBoard = db.prepare('SELECT id FROM boards WHERE id=?').get(DEFAULT_BOARD_ID);
  if (!defaultBoard && (taskCount > 0 || colCount > 0)) {
    db.prepare('INSERT INTO boards (id,name,icon,color,sort_order,folder_id) VALUES (?,?,?,?,?,?)')
      .run(DEFAULT_BOARD_ID, 'Operações', '📋', '#6c5ce7', 0, FOLDER_OP);
  }

  // Backfill nulls (rows that existed before the columns were added)
  db.prepare(`UPDATE tasks SET board_id=? WHERE board_id IS NULL OR board_id=''`).run(DEFAULT_BOARD_ID);
  db.prepare(`UPDATE columns_config SET board_id=? WHERE board_id IS NULL OR board_id=''`).run(DEFAULT_BOARD_ID);
  db.prepare(`UPDATE boards SET folder_id=? WHERE folder_id IS NULL OR folder_id=''`).run(FOLDER_OP);
})();

(function migrateAutomations() {
  const cols = db.prepare("PRAGMA table_info(automations)").all().map(c => c.name);
  if (!cols.includes('rule_config')) db.exec("ALTER TABLE automations ADD COLUMN rule_config TEXT");
  if (!cols.includes('natural_prompt')) db.exec("ALTER TABLE automations ADD COLUMN natural_prompt TEXT");
  if (!cols.includes('created_by')) db.exec("ALTER TABLE automations ADD COLUMN created_by TEXT");
  if (!cols.includes('last_run_at')) db.exec("ALTER TABLE automations ADD COLUMN last_run_at DATETIME");
  if (!cols.includes('last_run_status')) db.exec("ALTER TABLE automations ADD COLUMN last_run_status TEXT");
  if (!cols.includes('built_in')) {
    db.exec("ALTER TABLE automations ADD COLUMN built_in INTEGER DEFAULT 0");
    db.prepare("UPDATE automations SET built_in=1 WHERE built_in IS NULL OR built_in=0").run();
  }
})();

(function ensureNativeT2ComputedColumn() {
  const TARGET_COL_ID = 'col_total_canal_t2';
  const TARGET_TASK_ID = 't2';
  const COMPUTED_MARKER = 'row_sum_numeric_siblings';

  const taskExists = db.prepare("SELECT id FROM tasks WHERE id=?").get(TARGET_TASK_ID);
  if (!taskExists) return;

  const existingCol = db.prepare("SELECT id, computed FROM columns_config WHERE id=?").get(TARGET_COL_ID);
  if (!existingCol) {
    const m = db.prepare("SELECT MAX(sort_order) as m FROM columns_config").get().m || 0;
    db.prepare(`INSERT INTO columns_config
      (id, name, type, field, built_in, is_deadline, width, sort_order, scope, parent_column_id, task_id, computed, board_id)
      VALUES (?, ?, 'number', ?, 0, 0, '140px', ?, 'subitem', NULL, ?, ?, 'board_operacoes')`)
      .run(TARGET_COL_ID, 'TOTAL DE PEDIDOS POR CANAL DE VENDA', TARGET_COL_ID, m + 1, TARGET_TASK_ID, COMPUTED_MARKER);
  } else if (!existingCol.computed) {
    db.prepare("UPDATE columns_config SET computed=? WHERE id=?").run(COMPUTED_MARKER, TARGET_COL_ID);
  }

  db.prepare("DELETE FROM automations WHERE id='ai_sum_t2_channels'").run();
})();

(function cleanupOrphanCustomKeys() {
  const validColIds = new Set(db.prepare('SELECT id FROM columns_config').all().map(r => r.id));
  let removed = 0;
  const updTask = db.prepare('UPDATE tasks SET custom=? WHERE id=?');
  for (const t of db.prepare('SELECT id, custom FROM tasks').all()) {
    try {
      const cust = JSON.parse(t.custom || '{}');
      let changed = false;
      for (const k of Object.keys(cust)) {
        if (k === 'hiddenSubCols') {
          if (Array.isArray(cust[k])) {
            const before = cust[k].length;
            cust[k] = cust[k].filter(id => validColIds.has(id));
            if (cust[k].length !== before) { changed = true; removed += before - cust[k].length; }
          }
          continue;
        }
        if (!validColIds.has(k)) { delete cust[k]; changed = true; removed++; }
      }
      if (changed) updTask.run(JSON.stringify(cust), t.id);
    } catch {}
  }
  const updSub = db.prepare('UPDATE subitems SET custom=? WHERE id=?');
  for (const s of db.prepare('SELECT id, custom FROM subitems').all()) {
    try {
      const cust = JSON.parse(s.custom || '{}');
      let changed = false;
      for (const k of Object.keys(cust)) {
        if (!validColIds.has(k)) { delete cust[k]; changed = true; removed++; }
      }
      if (changed) updSub.run(JSON.stringify(cust), s.id);
    } catch {}
  }
  if (removed > 0) console.log(`🧹 Cleaned ${removed} orphan custom keys`);
})();

function seedDatabase() {
  if (db.prepare('SELECT COUNT(*) as c FROM users').get().c > 0) return;
  // For fresh DBs, ensure default folders + board exist before tasks/columns.
  if (!db.prepare("SELECT id FROM board_folders WHERE id='folder_operacionais'").get()) {
    db.prepare('INSERT INTO board_folders (id,name,icon,color,sort_order) VALUES (?,?,?,?,?)')
      .run('folder_operacionais', 'Operacionais', '⚙️', '#6c5ce7', 0);
  }
  if (!db.prepare("SELECT id FROM board_folders WHERE id='folder_gerenciais'").get()) {
    db.prepare('INSERT INTO board_folders (id,name,icon,color,sort_order) VALUES (?,?,?,?,?)')
      .run('folder_gerenciais', 'Gerenciais', '📊', '#00c875', 1);
  }
  if (!db.prepare("SELECT id FROM boards WHERE id='board_operacoes'").get()) {
    db.prepare('INSERT INTO boards (id,name,icon,color,sort_order,folder_id) VALUES (?,?,?,?,?,?)')
      .run('board_operacoes', 'Operações', '📋', '#6c5ce7', 0, 'folder_operacionais');
  }
  const hash = bcrypt.hashSync('123456', 10);
  const iu = db.prepare('INSERT INTO users (name,username,password,role,avatar_color) VALUES (?,?,?,?,?)');
  [['Gabriela','gabriela',hash,'collaborator','#ff642e'],['Camila','camila',hash,'collaborator','#fdab3d'],
   ['Junior','junior',hash,'admin','#a25ddc'],['Ana','ana',hash,'collaborator','#00c875'],
   ['Pedro','pedro',hash,'collaborator','#579bfc'],['Lucas','lucas',hash,'collaborator','#e2445c']].forEach(u=>iu.run(...u));

  const ic = db.prepare('INSERT INTO columns_config (id,name,type,field,built_in,is_deadline,width,sort_order) VALUES (?,?,?,?,?,?,?,?)');
  [['col_resp','Responsável','people','responsible',1,0,'110px',0],['col_status','Status','status','status',1,0,'120px',1],
   ['col_priority','Prioridade','priority','priority',1,0,'110px',2],['col_deadline','Prazo','date','deadline',1,1,'100px',3],
   ['col_orders','Pedidos','number','totalOrders',1,0,'80px',4],['col_cancel','Canc.','number','totalCancellations',1,0,'80px',5]].forEach(c=>ic.run(...c));

  const it = db.prepare('INSERT INTO tasks (id,name,status,priority,deadline,responsible,total_orders,total_cancellations,sort_order) VALUES (?,?,?,?,?,?,?,?,?)');
  const is = db.prepare('INSERT INTO subitems (id,task_id,name,owner,status,responsible,total,deadline,sort_order) VALUES (?,?,?,?,?,?,?,?,?)');
  const iup = db.prepare('INSERT INTO updates (id,target_type,target_id,author,text,mentions,files,created_at) VALUES (?,?,?,?,?,?,?,?)');

  const tx = db.transaction(() => {
    const tasks = [
      {id:'t1',name:'Verificar pedidos em plataformas',st:'Em andamento',pr:'Alta',dl:'2026-04-07',r:'["Gabriela","Camila"]',o:0,c:0,
        subs:[{id:'s1a',n:'Mercado Livre Tribo Nerd'},{id:'s1b',n:'Shoppe Oslo Closet'},{id:'s1c',n:'Shoppe Hungria'},{id:'s1d',n:'Shoppe FB Closet'},{id:'s1e',n:'Shoppe Moscow'},{id:'s1f',n:'X2'},{id:'s1g',n:'TikTok'},{id:'s1h',n:'Shein'}],
        ups:[{id:'u1',a:'Gabriela',t:'Pedidos verificados. @Camila pode continuar com Shopee?',m:'["Camila"]',f:'[]',tm:'2026-04-07T09:30:00'},{id:'u2',a:'Camila',t:'Vou verificar agora!',m:'[]',f:'[{"name":"relatorio.pdf","size":"245 KB"}]',tm:'2026-04-07T10:15:00'}]},
      {id:'t2',name:'Impressão Etiquetas Pedidos',st:'Em andamento',pr:'Alta',dl:'2026-04-07',r:'["Camila","Gabriela"]',o:740,c:0,
        subs:[{id:'s2a',n:'Shopee',total:446},{id:'s2b',n:'Shein'},{id:'s2c',n:'Mercado Livre',total:222},{id:'s2d',n:'TikTok Hungria',total:39}],
        ups:[{id:'u3',a:'Junior',t:'446 etiquetas impressas. @Gabriela confirmar ML.',m:'["Gabriela"]',f:'[{"name":"etiquetas.xlsx","size":"128 KB"}]',tm:'2026-04-07T08:00:00'}]},
      {id:'t3',name:'Relacionamento com clientes',st:'Em andamento',pr:'Alta',dl:'2026-04-07',r:'["Gabriela","Camila"]',o:0,c:0,
        subs:[{id:'s3a',n:'Responder Mercado Livre'},{id:'s3b',n:'Responder WhatsApp'},{id:'s3c',n:'Responder Instagram - Moscow Modas'},{id:'s3d',n:'Responder Instagram - Diverse'}]},
      {id:'t4',name:'Desconto plataformas',st:'Em andamento',pr:'Média',dl:'2026-04-07',r:'["Gabriela","Camila"]',o:0,c:0,
        subs:[{id:'s4a',n:'Shopee FB Closet',st:'Feito'},{id:'s4b',n:'Shopee Hungria',st:'Feito'},{id:'s4c',n:'Shopee Oslo'},{id:'s4d',n:'Shopee Moscow',st:'Parado'},{id:'s4e',n:'TikTok Oslo Closet',st:'Feito'}]},
      {id:'t5',name:'Desconto Shopee FB Closet',st:'Não iniciado',pr:'Alta',dl:null,r:'["Camila","Gabriela"]',o:0,c:0,
        subs:[{id:'s5a',n:'Bermuda Promo',st:'Feito',dl:'2026-04-06'},{id:'s5b',n:'Moletons Novos',dl:'2026-05-27'},{id:'s5c',n:'Polos Promos',dl:'2026-06-14'}]},
      {id:'t6',name:'Desconto Shopee Hungria',st:'Não iniciado',pr:'Alta',dl:null,r:'["Camila","Gabriela"]',o:0,c:0,
        subs:[{id:'s6a',n:'LA Tricolor',dl:'2026-04-06'},{id:'s6b',n:'Bermuda Feminina',dl:'2026-05-04'}]},
    ];
    tasks.forEach((t,ti)=>{
      it.run(t.id,t.name,t.st,t.pr,t.dl,t.r,t.o,t.c,ti);
      (t.subs||[]).forEach((s,si)=>is.run(s.id,t.id,s.n,'Junior',s.st||'Em andamento','["Camila","Gabriela"]',s.total||0,s.dl||null,si));
      (t.ups||[]).forEach(u=>iup.run(u.id,'task',t.id,u.a,u.t,u.m,u.f,u.tm));
    });
    const ia = db.prepare('INSERT INTO automations (id,name,description,icon,active) VALUES (?,?,?,?,?)');
    [['ai1','Atribuição inteligente','IA redistribui tarefas','🤖',0],['ai2','Priorização automática','IA ajusta prioridades','⚡',1],
     ['ai3','Alerta de atrasos','IA notifica riscos','🔔',1],['ai4','Resumo diário','IA gera resumo','📊',0],['ai5','Previsão de conclusão','IA prevê datas','🔮',1]].forEach(a=>ia.run(...a));
  });
  tx();
  console.log('✅ Database seeded');
}
seedDatabase();

// ===== Daily rollover (00:00 America/Sao_Paulo) =====
// BRT = UTC-3 year-round (Brazil abolished DST in 2019).
// getTime() JÁ é epoch em UTC — somar getTimezoneOffset() contava o
// deslocamento duas vezes e só dava certo com o servidor rodando em UTC (Render).
// Rodando na máquina do escritório, que está em BRT, o horário saía 3h adiantado:
// depois das 21:00 a data virava antes da hora e o rollover disparava cedo.
function brtParts(d = new Date()) {
  return new Date(d.getTime() - 3 * 3600000).toISOString();
}
function brtDateString(d = new Date()) {
  return brtParts(d).slice(0, 10);
}
// "HH:MM" 24h, mesmo formato que o <input type="time"> do cliente guarda.
// A hora sai daqui e não do navegador: o quadro é compartilhado, então o
// registro tem de ser o mesmo relógio para todo mundo.
function brtTimeString(d = new Date()) {
  return brtParts(d).slice(11, 16);
}

// ===== Horários automáticos por status =====
// Colunas de horário marcadas com auto_time recebem a hora do servidor quando a
// linha ENTRA no status correspondente. Só preenche o que está vazio: o badge de
// status cicla com um clique só, então regravar a cada passagem apagaria o
// horário real que já tinha sido registrado.
const AUTO_TIME_TRIGGER = { 'Em andamento': 'start', 'Feito': 'end' };

// Colunas automáticas que aparecem naquela linha: as do quadro e, para
// subitens, também as subcolunas daquela tarefa.
function autoTimeColumns(kind, boardId, taskId) {
  const cols = 'id, auto_time, auto_time_source';
  return kind === 'task'
    ? db.prepare(`SELECT ${cols} FROM columns_config WHERE auto_time IN ('start','end') AND scope='task' AND board_id=?`).all(boardId)
    : db.prepare(`SELECT ${cols} FROM columns_config WHERE auto_time IN ('start','end') AND board_id=? AND (scope='task' OR (scope='subitem' AND task_id=?))`).all(boardId, taskId);
}

// Onde mora o valor de uma coluna de status: a nativa do quadro fica no campo
// `status` da linha; as criadas pelo usuário ficam no custom, pela id delas.
// 'missing' = a coluna de origem foi excluída; nesse caso o horário nao dispara
// mais nada, em vez de silenciosamente passar a obedecer o status nativo.
function resolveStatusSource(srcId) {
  if (!srcId) return 'native';
  const c = db.prepare('SELECT built_in, field FROM columns_config WHERE id=?').get(srcId);
  if (!c) return 'missing';
  return (!!c.built_in && c.field === 'status') ? 'native' : 'custom';
}

// O cliente reenvia o custom inteiro a cada edição. Se ele ainda não recebeu o
// horário que o servidor acabou de gravar — o poll não passou, ou outro usuário
// mudou o status agora — esse envio apagaria o registro. Chave AUSENTE quer
// dizer "não sei deste valor": o que está gravado prevalece. Chave PRESENTE,
// mesmo vazia, é decisão explícita de quem editou e passa direto.
function preserveAutoTimes({ kind, stored, incoming, boardId, taskId }) {
  if (!incoming || !boardId) return incoming;
  const cols = autoTimeColumns(kind, boardId, taskId);
  if (cols.length === 0) return incoming;
  let prev = {};
  try { prev = JSON.parse(stored || '{}'); } catch { prev = {}; }
  const next = { ...incoming };
  for (const c of cols) {
    if (c.id in next) continue;
    const v = prev[c.id];
    if (v !== undefined && v !== null && v !== '') next[c.id] = v;
  }
  return next;
}

function applyAutoTimes({ kind, boardId, taskId, prevStatus, nextStatus, prevCustom, nextCustom }) {
  if (!boardId) return null;
  const cols = autoTimeColumns(kind, boardId, taskId);
  if (cols.length === 0) return null;

  let prevObj = {}, nextObj = {};
  try { prevObj = JSON.parse(prevCustom || '{}'); } catch { prevObj = {}; }
  try { nextObj = JSON.parse(nextCustom || '{}'); } catch { nextObj = {}; }
  // Cada horário observa a SUA coluna de status — um quadro pode ter várias e
  // elas não podem disputar o mesmo relógio.
  const kindCache = new Map();
  const srcKind = (src) => {
    if (!kindCache.has(src)) kindCache.set(src, resolveStatusSource(src));
    return kindCache.get(src);
  };
  const before = (src) => (srcKind(src) === 'native' ? prevStatus : prevObj[src]);
  const after = (src) => (srcKind(src) === 'native' ? nextStatus : nextObj[src]);

  const now = brtTimeString();
  let changed = false;
  for (const c of cols) {
    const src = c.auto_time_source || null;
    if (srcKind(src) === 'missing') continue;       // origem excluída: nao dispara
    const to = after(src);
    if (to === before(src)) continue;               // sem transição nessa origem
    if (AUTO_TIME_TRIGGER[to] !== c.auto_time) continue;
    const v = nextObj[c.id];
    if (v !== undefined && v !== null && v !== '') continue;
    nextObj[c.id] = now;
    changed = true;
  }
  return changed ? JSON.stringify(nextObj) : null;
}

function runDailyRollover() {
  const today = brtDateString();
  const row = db.prepare("SELECT value FROM settings WHERE key='last_rollover_date'").get();
  const last = row?.value;
  if (last === today) return;
  // Parent tasks always reflect "today" as deadline. Subitems are not touched.
  db.prepare('UPDATE tasks SET deadline=?').run(today);
  // First run ever: just record today, nothing to snapshot.
  if (!last) {
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('last_rollover_date',?)").run(today);
    return;
  }
  const numericSubCols = db.prepare(
    "SELECT id, name, task_id FROM columns_config WHERE scope='subitem' AND type='number' AND (computed IS NULL OR computed='')"
  ).all();
  // Horários automáticos são zerados na virada do dia. Sem isso, a regra "só
  // preenche se estiver vazio" faria o horário ser gravado uma única vez na vida
  // da tarefa — num quadro de rotina diária a função pararia de funcionar no dia
  // seguinte. Os valores não vão para daily_snapshots: a tabela guarda REAL.
  const autoTimeColIds = db.prepare("SELECT id FROM columns_config WHERE auto_time IN ('start','end')").all().map(c => c.id);
  const tasks = db.prepare('SELECT id, name, total_orders, total_cancellations, responsible, custom, board_id FROM tasks').all();
  const taskById = new Map(tasks.map(t => [t.id, t]));
  const subitems = db.prepare('SELECT id, task_id, name, total, custom, responsible FROM subitems').all();

  const insSnap = db.prepare(
    `INSERT OR REPLACE INTO daily_snapshots
     (date, task_id, subitem_id, column_id, value, responsible, task_name, subitem_name, column_name, board_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const updSub = db.prepare('UPDATE subitems SET total=0, custom=? WHERE id=?');
  const updTask = db.prepare('UPDATE tasks SET total_orders=0, total_cancellations=0 WHERE id=?');
  const updTaskCustom = db.prepare('UPDATE tasks SET custom=? WHERE id=?');

  const tx = db.transaction(() => {
    // Snapshot + zero subitem numeric columns
    for (const s of subitems) {
      const t = taskById.get(s.task_id);
      const taskName = t?.name || '';
      const boardId = t?.board_id || null;
      const resp = s.responsible || '[]';
      let custom = {};
      try { custom = JSON.parse(s.custom || '{}'); } catch {}
      // Built-in `total` field
      if (s.total && Number(s.total) !== 0) {
        insSnap.run(last, s.task_id, s.id, '__total__', Number(s.total), resp, taskName, s.name, 'TOTAL', boardId);
      }
      let customChanged = false;
      for (const col of numericSubCols) {
        // Per-task scoped columns only snapshot for their own task
        if (col.task_id && col.task_id !== s.task_id) continue;
        const v = custom[col.id];
        const num = typeof v === 'number' ? v : (v != null && v !== '' ? Number(v) : 0);
        if (num && !Number.isNaN(num)) {
          insSnap.run(last, s.task_id, s.id, col.id, num, resp, taskName, s.name, col.name, boardId);
        }
        if (col.id in custom) { delete custom[col.id]; customChanged = true; }
      }
      // Horários automáticos voltam a ficar vazios para o dia novo.
      for (const colId of autoTimeColIds) {
        if (colId in custom) { delete custom[colId]; customChanged = true; }
      }
      if ((s.total && Number(s.total) !== 0) || customChanged) {
        updSub.run(JSON.stringify(custom), s.id);
      }
    }
    // Snapshot + zero task totals
    for (const t of tasks) {
      if (autoTimeColIds.length > 0) {
        let custom = {};
        try { custom = JSON.parse(t.custom || '{}'); } catch {}
        let changed = false;
        for (const colId of autoTimeColIds) {
          if (colId in custom) { delete custom[colId]; changed = true; }
        }
        if (changed) updTaskCustom.run(JSON.stringify(custom), t.id);
      }
      if (t.total_orders && Number(t.total_orders) !== 0) {
        insSnap.run(last, t.id, '', 'totalOrders', Number(t.total_orders), t.responsible || '[]', t.name, '', 'Pedidos', t.board_id || null);
      }
      if (t.total_cancellations && Number(t.total_cancellations) !== 0) {
        insSnap.run(last, t.id, '', 'totalCancellations', Number(t.total_cancellations), t.responsible || '[]', t.name, '', 'Canc.', t.board_id || null);
      }
      if ((t.total_orders && Number(t.total_orders) !== 0) || (t.total_cancellations && Number(t.total_cancellations) !== 0)) {
        updTask.run(t.id);
      }
    }
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('last_rollover_date',?)").run(today);
  });
  tx();
  console.log(`🗓️  Rollover: snapshot de ${last} gravado, valores zerados para ${today}`);
}

// Run once on boot and before each authenticated request.
runDailyRollover();
setInterval(() => { try { runDailyRollover(); } catch (e) { console.error('Rollover err:', e); } }, 5 * 60 * 1000);

// ===== Daily on-disk backup (retention: last 7 days) =====
// Creates /data/backups/database.<YYYY-MM-DD>.sqlite once per BRT day using
// SQLite's online backup API (safe with WAL open). Files older than 7 days are pruned.
const BACKUP_DIR = path.join(path.dirname(DB_PATH), 'backups');
function runDailyBackup() {
  const today = brtDateString();
  const last = db.prepare("SELECT value FROM settings WHERE key='last_backup_date'").get()?.value;
  if (last === today) return;
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const dest = path.join(BACKUP_DIR, `database.${today}.sqlite`);
    const promise = db.backup(dest);
    Promise.resolve(promise).then(() => {
      db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('last_backup_date',?)").run(today);
      const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('database.') && f.endsWith('.sqlite')).sort();
      while (files.length > 7) {
        const old = files.shift();
        try { fs.unlinkSync(path.join(BACKUP_DIR, old)); } catch {}
      }
      console.log(`💾 Backup gravado: ${dest}`);
    }).catch(e => console.error('Backup err:', e.message));
  } catch (e) {
    console.error('Backup setup err:', e.message);
  }
}
runDailyBackup();
setInterval(() => { try { runDailyBackup(); } catch (e) { console.error('Backup tick err:', e.message); } }, 60 * 60 * 1000);

// ===== Scheduler de automações 'notify' =====
// Roda a cada 15 min, varrendo automações ativas type='notify' e executando.
// Idempotência por dia garantida pela tabela notification_log.
function runNotifyScheduler() {
  const rows = db.prepare("SELECT id, rule_config FROM automations WHERE active=1 AND rule_config IS NOT NULL").all();
  let totalApplied = 0;
  for (const row of rows) {
    let rule;
    try { rule = JSON.parse(row.rule_config); } catch { continue; }
    if (rule?.type !== 'notify') continue;
    try {
      const result = executeAutomation({ db, rule, ruleId: row.id });
      if (result.applied > 0) {
        console.log(`🔔 [${row.id}] ${result.summary}`);
        totalApplied += result.applied;
      }
      const status = result.errors.length ? `erro: ${result.errors[0]}` : `ok (${result.applied})`;
      db.prepare('UPDATE automations SET last_run_at=CURRENT_TIMESTAMP, last_run_status=? WHERE id=?').run(status, row.id);
    } catch (e) {
      console.error(`Notify scheduler err em ${row.id}:`, e.message);
    }
  }
  return totalApplied;
}
setTimeout(() => { try { runNotifyScheduler(); } catch (e) { console.error('Notify init err:', e.message); } }, 10 * 1000);
setInterval(() => { try { runNotifyScheduler(); } catch (e) { console.error('Notify tick err:', e.message); } }, 15 * 60 * 1000);

function auth(req,res,next){const t=req.headers.authorization?.split(' ')[1];if(!t)return res.status(401).json({error:'Token necessário'});try{req.user=jwt.verify(t,JWT_SECRET);next();}catch{return res.status(401).json({error:'Token inválido'});}}
function adminOnly(req,res,next){if(req.user.role!=='admin')return res.status(403).json({error:'Acesso restrito'});next();}
// Gerenciar automações (criar inclusive com IA, executar, ligar/desligar, excluir) é
// liberado para admin E colaborador (usuário comum). Espelha ROLE_CONFIG.manageAutomations no front.
function canManageAutomations(req,res,next){if(!['admin','collaborator'].includes(req.user.role))return res.status(403).json({error:'Acesso restrito'});next();}
// Criar e excluir tarefas é liberado para admin E colaborador (usuário comum).
// Espelha ROLE_CONFIG.deleteTasks/editTasks no front.
function canManageTasks(req,res,next){if(!['admin','collaborator'].includes(req.user.role))return res.status(403).json({error:'Acesso restrito'});next();}

// Auth para arquivos: aceita token via header OU query param (?token=...).
// O navegador nao envia Authorization header em <img src>, <a href> ou nova aba,
// entao precisamos do query param para visualizacao inline.
function authFile(req, res, next) {
  const t = req.headers.authorization?.split(' ')[1] || req.query.token;
  if (!t) return res.status(401).json({ error: 'Token necessário' });
  try { req.user = jwt.verify(t, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Token inválido' }); }
}

// Diretorio de uploads: persistente em prod (/data/uploads no Render),
// local em dev. Cada arquivo eh salvo como <id> + sidecar <id>.json com metadados.
const UPLOAD_DIR = process.env.UPLOAD_DIR || (DB_PATH.startsWith('/data') ? '/data/uploads' : path.join(__dirname, 'uploads'));
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const uploadHandler = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, _file, cb) => cb(null, crypto.randomBytes(12).toString('hex')),
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB por arquivo
});

// Login: username + password only. `email` is still accepted in the body so an
// old cached client keeps working (matched against username or legacy email).
app.post('/api/auth/login', (req, res) => {
  const { username, email, password } = req.body || {};
  const id = normalizeUsername(username ?? email);
  if (!id || !password) return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
  const u = db.prepare('SELECT * FROM users WHERE username=? OR lower(email)=?').get(id, id);
  if (!u || !bcrypt.compareSync(password, u.password)) return res.status(401).json({ error: 'Credenciais inválidas' });
  const token = jwt.sign({ id: u.id, name: u.name, username: u.username, role: u.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: u.id, name: u.name, username: u.username, role: u.role, phone: u.phone, department: u.department, bio: u.bio, avatar_color: u.avatar_color } });
});

// Public self-registration. New users default to 'collaborator' and must be
// promoted to 'admin' by an existing admin via /api/users/:id/role.
app.post('/api/auth/register', (req, res) => {
  const { name, username, password } = req.body || {};
  if (!name || !username || !password) return res.status(400).json({ error: 'Nome, usuário e senha são obrigatórios' });
  const trimmedName = String(name).trim();
  const un = normalizeUsername(username);
  if (trimmedName.length < 2) return res.status(400).json({ error: 'Nome muito curto' });
  if (!USERNAME_RE.test(un)) return res.status(400).json({ error: 'Usuário deve ter 3 a 20 caracteres (letras, números, . _ -)' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres' });
  if (db.prepare('SELECT id FROM users WHERE username=?').get(un)) return res.status(409).json({ error: 'Nome de usuário já existe' });
  const colors = ['#ff642e','#fdab3d','#a25ddc','#00c875','#579bfc','#e2445c','#6c5ce7','#00ced1','#ff158a','#037f4c'];
  const color = colors[Math.floor(Math.random() * colors.length)];
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users (name,username,password,role,avatar_color) VALUES (?,?,?,?,?)')
    .run(trimmedName, un, hash, 'collaborator', color);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
  const token = jwt.sign({ id: u.id, name: u.name, username: u.username, role: u.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: u.id, name: u.name, username: u.username, role: u.role, phone: u.phone || '', department: u.department || '', bio: u.bio || '', avatar_color: u.avatar_color } });
});

app.get('/api/auth/me',auth,(req,res)=>{const u=db.prepare('SELECT id,name,username,role,phone,department,bio,avatar_color,created_at FROM users WHERE id=?').get(req.user.id);if(!u)return res.status(404).json({error:'Não encontrado'});res.json(u);});

app.get('/api/users',auth,(req,res)=>res.json(db.prepare('SELECT id,name,username,role,phone,department,bio,avatar_color FROM users ORDER BY name').all()));
app.post('/api/users',auth,adminOnly,(req,res)=>{
  const { name, username, password, role } = req.body || {};
  if (!name || !username || !password) return res.status(400).json({ error: 'Nome, usuário e senha são obrigatórios' });
  if (password.length < 4) return res.status(400).json({ error: 'Senha deve ter pelo menos 4 caracteres' });
  const un = normalizeUsername(username);
  if (!USERNAME_RE.test(un)) return res.status(400).json({ error: 'Usuário deve ter 3 a 20 caracteres (letras, números, . _ -)' });
  if (db.prepare('SELECT id FROM users WHERE username=?').get(un)) return res.status(409).json({ error: 'Nome de usuário já existe' });
  const r = role === 'admin' ? 'admin' : 'collaborator';
  const colors = ['#ff642e','#fdab3d','#a25ddc','#00c875','#579bfc','#e2445c','#6c5ce7','#00ced1'];
  const color = colors[Math.floor(Math.random() * colors.length)];
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users (name,username,password,role,avatar_color) VALUES (?,?,?,?,?)').run(name.trim(), un, hash, r, color);
  res.json(db.prepare('SELECT id,name,username,role,phone,department,bio,avatar_color FROM users WHERE id=?').get(info.lastInsertRowid));
});
app.delete('/api/users/:id',auth,adminOnly,(req,res)=>{
  const id = parseInt(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Não pode excluir a si mesmo' });
  const target = db.prepare('SELECT name, role FROM users WHERE id=?').get(id);
  if (!target) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (target.role === 'admin') {
    const ac = db.prepare("SELECT COUNT(*) as c FROM users WHERE role='admin'").get().c;
    if (ac <= 1) return res.status(400).json({ error: 'Precisa de pelo menos 1 administrador' });
  }
  const removedName = target.name;
  // Cascade-clean: remove the deleted name from every responsible array.
  // Names are stored as strings (not IDs) in tasks.responsible / subitems.responsible.
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM users WHERE id=?').run(id);
    db.prepare('DELETE FROM board_members WHERE user_id=?').run(id);
    let cleaned = 0;
    const updTask = db.prepare('UPDATE tasks SET responsible=? WHERE id=?');
    for (const t of db.prepare('SELECT id, responsible FROM tasks').all()) {
      try {
        const arr = JSON.parse(t.responsible || '[]');
        if (Array.isArray(arr) && arr.includes(removedName)) {
          updTask.run(JSON.stringify(arr.filter(n => n !== removedName)), t.id);
          cleaned++;
        }
      } catch {}
    }
    const updSub = db.prepare('UPDATE subitems SET responsible=? WHERE id=?');
    for (const s of db.prepare('SELECT id, responsible FROM subitems').all()) {
      try {
        const arr = JSON.parse(s.responsible || '[]');
        if (Array.isArray(arr) && arr.includes(removedName)) {
          updSub.run(JSON.stringify(arr.filter(n => n !== removedName)), s.id);
          cleaned++;
        }
      } catch {}
    }
    if (cleaned > 0) console.log(`🧹 Removido "${removedName}" de ${cleaned} responsavel(es)`);
  });
  tx();
  res.json({ success: true });
});
app.put('/api/users/:id', auth, (req, res) => {
  const { id } = req.params;
  if (req.user.id !== parseInt(id) && req.user.role !== 'admin') return res.status(403).json({ error: 'Sem permissão' });
  const { name, username, phone, department, bio, avatar_color, password } = req.body;
  const u = []; const p = [];
  if (name) { u.push('name=?'); p.push(name); }
  if (username) {
    const un = normalizeUsername(username);
    if (!USERNAME_RE.test(un)) return res.status(400).json({ error: 'Usuário deve ter 3 a 20 caracteres (letras, números, . _ -)' });
    if (db.prepare('SELECT id FROM users WHERE username=? AND id<>?').get(un, id)) return res.status(409).json({ error: 'Nome de usuário já existe' });
    u.push('username=?'); p.push(un);
  }
  if (phone !== undefined) { u.push('phone=?'); p.push(phone); }
  if (department !== undefined) { u.push('department=?'); p.push(department); }
  if (bio !== undefined) { u.push('bio=?'); p.push(bio); }
  if (avatar_color) { u.push('avatar_color=?'); p.push(avatar_color); }
  if (password) { u.push('password=?'); p.push(bcrypt.hashSync(password, 10)); }
  if (!u.length) return res.status(400).json({ error: 'Nada para atualizar' });
  p.push(id);
  db.prepare(`UPDATE users SET ${u.join(',')} WHERE id=?`).run(...p);
  res.json(db.prepare('SELECT id,name,username,role,phone,department,bio,avatar_color FROM users WHERE id=?').get(id));
});
app.put('/api/users/:id/role',auth,adminOnly,(req,res)=>{const{role}=req.body;if(!['admin','collaborator'].includes(role))return res.status(400).json({error:'Cargo inválido'});const ac=db.prepare("SELECT COUNT(*) as c FROM users WHERE role='admin'").get().c;const t=db.prepare('SELECT role FROM users WHERE id=?').get(req.params.id);if(t?.role==='admin'&&role!=='admin'&&ac<=1)return res.status(400).json({error:'Precisa de 1 admin'});db.prepare('UPDATE users SET role=? WHERE id=?').run(role,req.params.id);res.json({success:true});});

// ===== Folders =====
// Usuário comum só recebe as pastas que contêm ao menos um quadro que ele
// pode abrir. Sem isso, a pasta de um quadro sem acesso aparecia na barra
// lateral (vazia), revelando a existência do quadro para quem não participa.
app.get('/api/folders', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM board_folders ORDER BY sort_order, created_at').all();
  let visiveis = rows;
  if (req.user.role !== 'admin') {
    const acessiveis = getAccessibleBoardIds(req.user.name, req.user.id);
    const comAcesso = new Set(
      db.prepare('SELECT id, folder_id FROM boards').all()
        .filter(b => acessiveis.has(b.id))
        .map(b => b.folder_id)
    );
    visiveis = rows.filter(f => comAcesso.has(f.id));
  }
  res.json(visiveis.map(f => ({ id: f.id, name: f.name, icon: f.icon, color: f.color, sortOrder: f.sort_order, createdAt: f.created_at })));
});

app.post('/api/folders', auth, adminOnly, (req, res) => {
  const { name, icon, color } = req.body || {};
  const trimmed = (name || '').trim();
  if (!trimmed) return res.status(400).json({ error: 'Nome da pasta obrigatório' });
  const id = 'folder_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const m = db.prepare('SELECT MAX(sort_order) as m FROM board_folders').get().m || 0;
  db.prepare('INSERT INTO board_folders (id,name,icon,color,sort_order) VALUES (?,?,?,?,?)')
    .run(id, trimmed, icon || '📁', color || '#778ca3', m + 1);
  const row = db.prepare('SELECT * FROM board_folders WHERE id=?').get(id);
  res.json({ id: row.id, name: row.name, icon: row.icon, color: row.color, sortOrder: row.sort_order, createdAt: row.created_at });
});

app.put('/api/folders/:id', auth, adminOnly, (req, res) => {
  const { name, icon, color } = req.body || {};
  const f = db.prepare('SELECT * FROM board_folders WHERE id=?').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Pasta não encontrada' });
  const upd = []; const params = [];
  if (name !== undefined) { upd.push('name=?'); params.push(String(name).trim() || f.name); }
  if (icon !== undefined) { upd.push('icon=?'); params.push(icon || f.icon); }
  if (color !== undefined) { upd.push('color=?'); params.push(color || f.color); }
  if (!upd.length) return res.status(400).json({ error: 'Nada para atualizar' });
  params.push(req.params.id);
  db.prepare(`UPDATE board_folders SET ${upd.join(',')} WHERE id=?`).run(...params);
  const row = db.prepare('SELECT * FROM board_folders WHERE id=?').get(req.params.id);
  res.json({ id: row.id, name: row.name, icon: row.icon, color: row.color, sortOrder: row.sort_order, createdAt: row.created_at });
});

app.put('/api/folders/reorder', auth, adminOnly, (req, res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order deve ser array' });
  const upd = db.prepare('UPDATE board_folders SET sort_order=? WHERE id=?');
  const tx = db.transaction((ids) => { ids.forEach((id, i) => upd.run(i, id)); });
  tx(order);
  res.json({ success: true });
});

app.delete('/api/folders/:id', auth, adminOnly, (req, res) => {
  const id = req.params.id;
  if (!db.prepare('SELECT id FROM board_folders WHERE id=?').get(id)) return res.status(404).json({ error: 'Pasta não encontrada' });
  const boardCount = db.prepare('SELECT COUNT(*) as c FROM boards WHERE folder_id=?').get(id).c;
  if (boardCount > 0) return res.status(400).json({ error: 'Pasta contém quadros. Mova-os ou exclua antes.' });
  const total = db.prepare('SELECT COUNT(*) as c FROM board_folders').get().c;
  if (total <= 1) return res.status(400).json({ error: 'Não é possível excluir a última pasta' });
  db.prepare('DELETE FROM board_folders WHERE id=?').run(id);
  res.json({ success: true });
});

// ===== Boards =====
// Quadros visíveis para o usuário. Duas regras, escolhidas por quadro:
//   restricted=0 (padrão): lista de acesso SOMA com a responsabilidade — quem
//     está em board_members OU é responsável por tarefa/subitem enxerga.
//   restricted=1: SÓ a lista de acesso vale. Ser responsável por uma tarefa
//     não abre mais o quadro. É o que permite tirar alguém de vez.
// Admin enxerga todos, nos dois casos.
function getAccessibleBoardIds(userName, userId) {
  const ids = new Set();
  const restritos = new Set(db.prepare('SELECT id FROM boards WHERE restricted=1').all().map(b => b.id));
  if (userId != null) {
    for (const m of db.prepare('SELECT board_id FROM board_members WHERE user_id=?').all(userId)) ids.add(m.board_id);
  }
  for (const t of db.prepare('SELECT board_id, responsible FROM tasks').all()) {
    if (restritos.has(t.board_id)) continue;
    try {
      const arr = JSON.parse(t.responsible || '[]');
      if (Array.isArray(arr) && arr.includes(userName)) ids.add(t.board_id);
    } catch {}
  }
  for (const s of db.prepare(
    'SELECT t.board_id AS board_id, s.responsible AS responsible FROM subitems s JOIN tasks t ON s.task_id = t.id'
  ).all()) {
    if (restritos.has(s.board_id)) continue;
    try {
      const arr = JSON.parse(s.responsible || '[]');
      if (Array.isArray(arr) && arr.includes(userName)) ids.add(s.board_id);
    } catch {}
  }
  return ids;
}

function userCanAccessBoard(user, boardId) {
  if (!boardId) return false;
  if (user.role === 'admin') return true;
  return getAccessibleBoardIds(user.name, user.id).has(boardId);
}

// ===== Atividade por quadro =====
// A barra lateral mostra um número no começo do nome de cada quadro com quantas
// alterações ele acumulou desde a última vez que o usuário o abriu. O poll só
// carrega o quadro ATIVO, então essa contagem tem de vir do servidor.
//
// O cliente manda a marca "visto por último" de cada quadro em epoch ms; o
// relógio de referência é sempre o do servidor (devolvido em `now`), para
// diferença de horário entre as máquinas não inventar nem esconder alteração.
// Quadro sem marca conta zero: quem entra agora não deve levar um histórico
// inteiro na cara.
function sqlTimestamp(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}
app.get('/api/boards/activity', auth, (req, res) => {
  let seen = {};
  try { seen = JSON.parse(req.query.seen || '{}') || {}; } catch { seen = {}; }
  const now = Date.now();

  let boardIds = db.prepare('SELECT id FROM boards').all().map(b => b.id);
  if (req.user.role !== 'admin') {
    const accessible = getAccessibleBoardIds(req.user.name, req.user.id);
    boardIds = boardIds.filter(id => accessible.has(id));
  }

  const qTasks = db.prepare('SELECT COUNT(*) c FROM tasks WHERE board_id=? AND updated_at > ?');
  const qSubs = db.prepare('SELECT COUNT(*) c FROM subitems s JOIN tasks t ON t.id=s.task_id WHERE t.board_id=? AND s.updated_at > ?');
  const qUpdates = db.prepare(`SELECT COUNT(*) c FROM updates u WHERE u.created_at > ? AND u.author <> ? AND (
      (u.target_type='task' AND u.target_id IN (SELECT id FROM tasks WHERE board_id=?))
   OR (u.target_type='subitem' AND u.target_id IN (SELECT s.id FROM subitems s JOIN tasks t ON t.id=s.task_id WHERE t.board_id=?)))`);

  const counts = {};
  for (const id of boardIds) {
    const raw = Number(seen[id]);
    if (!Number.isFinite(raw) || raw <= 0) { counts[id] = 0; continue; }
    const ts = sqlTimestamp(Math.min(raw, now));
    counts[id] = qTasks.get(id, ts).c + qSubs.get(id, ts).c + qUpdates.get(ts, req.user.name, id, id).c;
  }
  res.json({ now, counts });
});

app.get('/api/boards', auth, (req, res) => {
  let rows = db.prepare('SELECT * FROM boards ORDER BY sort_order, created_at').all();
  if (req.user.role !== 'admin') {
    const accessible = getAccessibleBoardIds(req.user.name, req.user.id);
    rows = rows.filter(b => accessible.has(b.id));
  }
  res.json(rows.map(b => ({ id: b.id, name: b.name, icon: b.icon, color: b.color, sortOrder: b.sort_order, folderId: b.folder_id, restricted: !!b.restricted, createdAt: b.created_at })));
});

app.post('/api/boards', auth, adminOnly, (req, res) => {
  const { name, icon, color, copyFromId, folderId } = req.body || {};
  const trimmed = (name || '').trim();
  if (!trimmed) return res.status(400).json({ error: 'Nome do quadro obrigatório' });
  const folder = folderId || 'folder_operacionais';
  if (!db.prepare('SELECT id FROM board_folders WHERE id=?').get(folder)) return res.status(400).json({ error: 'Pasta inválida' });
  const id = 'board_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const m = db.prepare('SELECT MAX(sort_order) as m FROM boards').get().m || 0;
  const finalIcon = icon || '📋';
  const finalColor = color || '#6c5ce7';

  const tx = db.transaction(() => {
    db.prepare('INSERT INTO boards (id,name,icon,color,sort_order,folder_id) VALUES (?,?,?,?,?,?)').run(id, trimmed, finalIcon, finalColor, m + 1, folder);
    if (copyFromId) {
      // Copy structure (columns + sub-columns) only — no tasks/subitems/updates.
      const src = db.prepare('SELECT id FROM boards WHERE id=?').get(copyFromId);
      if (!src) throw new Error('Quadro de origem não encontrado');
      const srcCols = db.prepare(
        "SELECT * FROM columns_config WHERE board_id=? AND (computed IS NULL OR computed='') ORDER BY sort_order"
      ).all(copyFromId);
      // Map old col id -> new col id (so parent_column_id linking is preserved)
      const idMap = new Map();
      const baseSort = db.prepare('SELECT MAX(sort_order) as m FROM columns_config').get().m || 0;
      const insCol = db.prepare(
        `INSERT INTO columns_config (id,name,type,field,built_in,is_deadline,width,sort_order,scope,parent_column_id,task_id,computed,board_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      // First pass: task-scope columns. Skip board-specific built-ins (Pedidos/Canc.)
      // and skip per-task scoped sub-columns since target board has no tasks yet.
      let so = baseSort;
      for (const c of srcCols) {
        if (c.scope === 'subitem' && c.task_id) continue;
        // Built-in Pedidos/Canc. only live in Operações.
        if (c.built_in && (c.field === 'totalOrders' || c.field === 'totalCancellations')) continue;
        const newId = c.built_in ? c.id + '__' + id : 'col_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        idMap.set(c.id, newId);
        so++;
        insCol.run(
          newId, c.name, c.type, c.field, c.built_in, c.is_deadline, c.width, so,
          c.scope || 'task',
          c.parent_column_id ? (idMap.get(c.parent_column_id) || null) : null,
          null,
          null,
          id
        );
      }
    } else {
      // Blank board: seed essential columns (task name is implicit/native).
      const baseSort = db.prepare('SELECT MAX(sort_order) as m FROM columns_config').get().m || 0;
      const ins = db.prepare(
        `INSERT INTO columns_config (id,name,type,field,built_in,is_deadline,width,sort_order,scope,board_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      );
      const cols = [
        ['Responsável', 'people',   'responsible', 1, 0, '110px'],
        ['Status',      'status',   'status',      1, 0, '120px'],
        ['Prioridade',  'priority', 'priority',    1, 0, '110px'],
        ['Prazo',       'date',     'deadline',    1, 1, '100px'],
      ];
      cols.forEach((c, i) => {
        const newId = `col_${c[2]}__${id}`;
        ins.run(newId, c[0], c[1], c[2], c[3], c[4], c[5], baseSort + i + 1, 'task', id);
      });
    }
  });

  try {
    tx();
    const row = db.prepare('SELECT * FROM boards WHERE id=?').get(id);
    res.json({ id: row.id, name: row.name, icon: row.icon, color: row.color, sortOrder: row.sort_order, folderId: row.folder_id, createdAt: row.created_at });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/boards/:id', auth, adminOnly, (req, res) => {
  const { name, icon, color, folderId, restricted } = req.body || {};
  const b = db.prepare('SELECT * FROM boards WHERE id=?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Quadro não encontrado' });
  const upd = [];
  const params = [];
  if (name !== undefined) { upd.push('name=?'); params.push(String(name).trim() || b.name); }
  if (icon !== undefined) { upd.push('icon=?'); params.push(icon || b.icon); }
  if (color !== undefined) { upd.push('color=?'); params.push(color || b.color); }
  if (folderId !== undefined) {
    if (!db.prepare('SELECT id FROM board_folders WHERE id=?').get(folderId)) return res.status(400).json({ error: 'Pasta inválida' });
    upd.push('folder_id=?'); params.push(folderId);
  }
  if (restricted !== undefined) { upd.push('restricted=?'); params.push(restricted ? 1 : 0); }
  if (!upd.length) return res.status(400).json({ error: 'Nada para atualizar' });
  params.push(req.params.id);
  db.prepare(`UPDATE boards SET ${upd.join(',')} WHERE id=?`).run(...params);
  const row = db.prepare('SELECT * FROM boards WHERE id=?').get(req.params.id);
  res.json({ id: row.id, name: row.name, icon: row.icon, color: row.color, sortOrder: row.sort_order, folderId: row.folder_id, restricted: !!row.restricted, createdAt: row.created_at });
});

app.put('/api/boards/reorder', auth, adminOnly, (req, res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order deve ser array' });
  const upd = db.prepare('UPDATE boards SET sort_order=? WHERE id=?');
  const tx = db.transaction((ids) => { ids.forEach((id, i) => upd.run(i, id)); });
  tx(order);
  res.json({ success: true });
});

// ===== Acesso ao quadro =====
// Lista quem tem acesso: liberado explicitamente pelo admin (member) e/ou por
// ser responsável em alguma tarefa/subitem do quadro (responsible). Admin vê
// tudo por definição do papel, então aparece marcado como 'admin'.
app.get('/api/boards/:id/members', auth, adminOnly, (req, res) => {
  const boardId = req.params.id;
  const board = db.prepare('SELECT id, restricted FROM boards WHERE id=?').get(boardId);
  if (!board) return res.status(404).json({ error: 'Quadro não encontrado' });

  const explicit = new Set(db.prepare('SELECT user_id FROM board_members WHERE board_id=?').all(boardId).map(r => r.user_id));
  // Onde exatamente cada nome aparece como responsável neste quadro. Guardar o
  // local (e não só um sim/não) é o que permite responder "por que fulano vê
  // este quadro" sem ter que vasculhar o banco na mão.
  const locais = {};
  const marcar = (json, onde) => {
    try { (JSON.parse(json || '[]') || []).forEach(n => { (locais[n] = locais[n] || []).push(onde); }); } catch {}
  };
  for (const t of db.prepare('SELECT name, responsible FROM tasks WHERE board_id=?').all(boardId)) {
    marcar(t.responsible, `tarefa "${t.name}"`);
  }
  for (const s of db.prepare('SELECT s.name AS sname, s.responsible AS r, t.name AS tname FROM subitems s JOIN tasks t ON s.task_id=t.id WHERE t.board_id=?').all(boardId)) {
    marcar(s.r, `subitem "${s.sname}" (em "${s.tname}")`);
  }

  const users = db.prepare('SELECT id, name, username, role FROM users ORDER BY name').all();
  const restrito = !!board.restricted;
  res.json({
    restricted: restrito,
    users: users.map(u => {
      const onde = locais[u.name] || [];
      // Em quadro restrito, ser responsável não abre mais o acesso.
      const enxergaPorTarefa = onde.length > 0 && !restrito;
      return {
        id: u.id, name: u.name, username: u.username, role: u.role,
        member: explicit.has(u.id),
        viaTask: onde.length > 0,
        where: onde.slice(0, 12),
        // Por que este usuário enxerga o quadro hoje.
        reason: u.role === 'admin' ? 'admin' : (explicit.has(u.id) ? 'member' : (enxergaPorTarefa ? 'task' : null)),
      };
    }),
  });
});

// Substitui a lista de acesso explícito do quadro.
app.put('/api/boards/:id/members', auth, adminOnly, (req, res) => {
  const boardId = req.params.id;
  const { userIds } = req.body || {};
  if (!Array.isArray(userIds)) return res.status(400).json({ error: 'userIds deve ser array' });
  if (!db.prepare('SELECT id FROM boards WHERE id=?').get(boardId)) return res.status(404).json({ error: 'Quadro não encontrado' });

  const valid = new Set(db.prepare('SELECT id FROM users').all().map(u => u.id));
  const ins = db.prepare('INSERT OR IGNORE INTO board_members (board_id, user_id) VALUES (?,?)');
  const tx = db.transaction((ids) => {
    db.prepare('DELETE FROM board_members WHERE board_id=?').run(boardId);
    ids.filter(id => valid.has(id)).forEach(id => ins.run(boardId, id));
  });
  tx(userIds.map(Number));
  res.json({ success: true, count: db.prepare('SELECT COUNT(*) as c FROM board_members WHERE board_id=?').get(boardId).c });
});

app.delete('/api/boards/:id', auth, adminOnly, (req, res) => {
  const id = req.params.id;
  const total = db.prepare('SELECT COUNT(*) as c FROM boards').get().c;
  if (total <= 1) return res.status(400).json({ error: 'Não é possível excluir o último quadro' });
  if (!db.prepare('SELECT id FROM boards WHERE id=?').get(id)) return res.status(404).json({ error: 'Quadro não encontrado' });
  const tx = db.transaction(() => {
    // Cascade: subitems via FK ON DELETE CASCADE on tasks. Delete columns + tasks explicitly.
    db.prepare('DELETE FROM board_members WHERE board_id=?').run(id);
    db.prepare('DELETE FROM columns_config WHERE board_id=?').run(id);
    db.prepare('DELETE FROM tasks WHERE board_id=?').run(id);
    db.prepare('DELETE FROM boards WHERE id=?').run(id);
  });
  tx();
  res.json({ success: true });
});

app.put('/api/tasks/reorder',auth,(req,res)=>{const{order}=req.body;if(!Array.isArray(order))return res.status(400).json({error:'order deve ser array'});const upd=db.prepare('UPDATE tasks SET sort_order=? WHERE id=?');const tx=db.transaction((ids)=>{ids.forEach((id,i)=>upd.run(i,id));});tx(order);res.json({success:true});});
app.put('/api/subitems/reorder',auth,(req,res)=>{const{taskId,order}=req.body;if(!taskId||!Array.isArray(order))return res.status(400).json({error:'taskId e order obrigatorios'});const upd=db.prepare('UPDATE subitems SET sort_order=? WHERE id=? AND task_id=?');const tx=db.transaction((ids)=>{ids.forEach((id,i)=>upd.run(i,id,taskId));});tx(order);res.json({success:true});});
app.get('/api/tasks',auth,(req,res)=>{
  const boardId = req.query.boardId || null;
  if (boardId && !userCanAccessBoard(req.user, boardId)) {
    return res.status(403).json({ error: 'Sem acesso a este quadro' });
  }
  const tasks = boardId
    ? db.prepare('SELECT * FROM tasks WHERE board_id=? ORDER BY sort_order').all(boardId)
    : db.prepare('SELECT * FROM tasks ORDER BY sort_order').all();
  const subs = db.prepare('SELECT * FROM subitems ORDER BY sort_order').all();
  const ups = db.prepare('SELECT * FROM updates ORDER BY created_at').all();
  res.json(tasks.map(t => ({
    id: t.id, name: t.name, status: t.status, priority: t.priority, deadline: t.deadline,
    responsible: JSON.parse(t.responsible), totalOrders: t.total_orders, totalCancellations: t.total_cancellations,
    custom: JSON.parse(t.custom), boardId: t.board_id,
    subitems: subs.filter(s => s.task_id === t.id).map(s => ({
      id: s.id, name: s.name, owner: s.owner, status: s.status, responsible: JSON.parse(s.responsible),
      total: s.total, deadline: s.deadline, custom: JSON.parse(s.custom), priority: s.priority || 'Média', cancellations: 0,
      updates: ups.filter(u => u.target_type === 'subitem' && u.target_id === s.id).map(u => ({ id: u.id, author: u.author, text: u.text, mentions: JSON.parse(u.mentions), files: JSON.parse(u.files), time: u.created_at }))
    })),
    updates: ups.filter(u => u.target_type === 'task' && u.target_id === t.id).map(u => ({ id: u.id, author: u.author, text: u.text, mentions: JSON.parse(u.mentions), files: JSON.parse(u.files), time: u.created_at }))
  })));
});
app.post('/api/tasks',auth,(req,res)=>{
  const { id, name, status, priority, responsible, totalOrders, totalCancellations, custom, boardId } = req.body;
  const board = boardId || 'board_operacoes';
  if (!db.prepare('SELECT id FROM boards WHERE id=?').get(board)) return res.status(400).json({ error: 'Quadro inválido' });
  const m = db.prepare('SELECT MAX(sort_order) as m FROM tasks WHERE board_id=?').get(board).m || 0;
  // Parent deadline always reflects today; client-provided value is ignored.
  db.prepare('INSERT INTO tasks (id,name,status,priority,deadline,responsible,total_orders,total_cancellations,custom,sort_order,board_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, name, status || 'Não iniciado', priority || 'Média', brtDateString(), JSON.stringify(responsible || []), totalOrders || 0, totalCancellations || 0, JSON.stringify(custom || {}), m + 1, board);
  res.json({ success: true });
});
app.put('/api/tasks/:id',auth,(req,res)=>{
  const { name, status, priority, responsible, totalOrders, totalCancellations, custom } = req.body;
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Não encontrada' });
  const nextStatus = status ?? t.status;
  // Horários automáticos entram por cima do custom final (o do corpo, se veio),
  // nunca por baixo — senão a escrita do cliente apagaria o horário recém-gravado.
  let nextCustom = custom
    ? JSON.stringify(preserveAutoTimes({ kind: 'task', stored: t.custom, incoming: custom, boardId: t.board_id }))
    : t.custom;
  const withTimes = applyAutoTimes({ kind: 'task', boardId: t.board_id, prevStatus: t.status, nextStatus, prevCustom: t.custom, nextCustom });
  if (withTimes) nextCustom = withTimes;
  // Parent deadline is auto-managed by runDailyRollover; client value is ignored.
  db.prepare('UPDATE tasks SET name=?,status=?,priority=?,responsible=?,total_orders=?,total_cancellations=?,custom=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(name ?? t.name, nextStatus, priority ?? t.priority, responsible ? JSON.stringify(responsible) : t.responsible, totalOrders ?? t.total_orders, totalCancellations ?? t.total_cancellations, nextCustom, req.params.id);
  // Devolve o custom para o cliente mostrar o horário na hora, sem esperar o poll.
  let out = {}; try { out = JSON.parse(nextCustom || '{}'); } catch {}
  res.json({ success: true, custom: out });
});
app.delete('/api/tasks/:id', auth, canManageTasks, (req, res) => {
  const id = req.params.id;
  if (!db.prepare('SELECT id FROM tasks WHERE id=?').get(id)) return res.status(404).json({ error: 'Tarefa não encontrada' });
  // Subitems cascade via FK; we still need to manually clean updates (no FK).
  const tx = db.transaction(() => {
    const subIds = db.prepare('SELECT id FROM subitems WHERE task_id=?').all(id).map(s => s.id);
    db.prepare("DELETE FROM updates WHERE target_type='task' AND target_id=?").run(id);
    if (subIds.length > 0) {
      const placeholders = subIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM updates WHERE target_type='subitem' AND target_id IN (${placeholders})`).run(...subIds);
    }
    db.prepare('DELETE FROM tasks WHERE id=?').run(id);
  });
  tx();
  res.json({ success: true });
});

app.put('/api/subitems/:id',auth,(req,res)=>{
  const { name, owner, status, priority, responsible, total, deadline, custom } = req.body;
  const s = db.prepare('SELECT * FROM subitems WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Não encontrado' });
  const nextStatus = status ?? s.status;
  const boardId = db.prepare('SELECT board_id FROM tasks WHERE id=?').get(s.task_id)?.board_id || null;
  let nextCustom = custom
    ? JSON.stringify(preserveAutoTimes({ kind: 'subitem', stored: s.custom, incoming: custom, boardId, taskId: s.task_id }))
    : s.custom;
  const withTimes = applyAutoTimes({ kind: 'subitem', boardId, taskId: s.task_id, prevStatus: s.status, nextStatus, prevCustom: s.custom, nextCustom });
  if (withTimes) nextCustom = withTimes;
  db.prepare('UPDATE subitems SET name=?,owner=?,status=?,priority=?,responsible=?,total=?,deadline=?,custom=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(name ?? s.name, owner ?? s.owner, nextStatus, priority ?? s.priority, responsible ? JSON.stringify(responsible) : s.responsible, total ?? s.total, deadline !== undefined ? deadline : s.deadline, nextCustom, req.params.id);
  let out = {}; try { out = JSON.parse(nextCustom || '{}'); } catch {}
  res.json({ success: true, custom: out });
});
app.post('/api/subitems',auth,(req,res)=>{const{id,task_id,name,owner,status,priority,responsible,total,deadline,custom}=req.body;const m=db.prepare('SELECT MAX(sort_order) as m FROM subitems WHERE task_id=?').get(task_id);db.prepare('INSERT INTO subitems (id,task_id,name,owner,status,priority,responsible,total,deadline,custom,sort_order,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)').run(id,task_id,name||'Novo subitem',owner||'',status||'Não iniciado',priority||'Média',JSON.stringify(responsible||[]),total||0,deadline||null,JSON.stringify(custom||{}),(m?.m||0)+1);res.json({success:true});});

app.post('/api/updates',auth,(req,res)=>{const{id,targetType,targetId,text,mentions,files}=req.body;db.prepare('INSERT INTO updates (id,target_type,target_id,author,text,mentions,files) VALUES(?,?,?,?,?,?,?)').run(id,targetType,targetId,req.user.name,text||'',JSON.stringify(mentions||[]),JSON.stringify(files||[]));res.json({success:true});});
app.delete('/api/updates/:id',auth,(req,res)=>{const u=db.prepare('SELECT author FROM updates WHERE id=?').get(req.params.id);if(!u)return res.status(404).json({error:'Relatório não encontrado'});if(u.author!==req.user.name&&req.user.role!=='admin')return res.status(403).json({error:'Apenas o autor pode excluir'});db.prepare('DELETE FROM updates WHERE id=?').run(req.params.id);res.json({success:true});});

app.get('/api/columns',auth,(req,res)=>{
  const boardId = req.query.boardId || null;
  if (boardId && !userCanAccessBoard(req.user, boardId)) {
    return res.status(403).json({ error: 'Sem acesso a este quadro' });
  }
  const rows = boardId
    ? db.prepare('SELECT * FROM columns_config WHERE board_id=? ORDER BY sort_order').all(boardId)
    : db.prepare('SELECT * FROM columns_config ORDER BY sort_order').all();
  res.json(rows.map(c => ({ id: c.id, name: c.name, type: c.type, field: c.field, builtIn: !!c.built_in, isDeadline: !!c.is_deadline, width: c.width, scope: c.scope || 'task', parentColumnId: c.parent_column_id || null, taskId: c.task_id || null, computed: c.computed || null, autoTime: c.auto_time || null, autoTimeSource: c.auto_time_source || null, boardId: c.board_id || 'board_operacoes' })));
});
app.put('/api/columns/reorder',auth,(req,res)=>{const{order}=req.body;if(!Array.isArray(order))return res.status(400).json({error:'order deve ser array'});const upd=db.prepare('UPDATE columns_config SET sort_order=? WHERE id=?');const tx=db.transaction((ids)=>{ids.forEach((id,i)=>upd.run(i,id));});tx(order);res.json({success:true});});
app.post('/api/columns',auth,(req,res)=>{
  const { id, name, type, field, isDeadline, width, scope, parentColumnId, taskId, computed, autoTime, autoTimeSource, boardId } = req.body;
  const board = boardId || 'board_operacoes';
  if (!db.prepare('SELECT id FROM boards WHERE id=?').get(board)) return res.status(400).json({ error: 'Quadro inválido' });
  const m = db.prepare('SELECT MAX(sort_order) as m FROM columns_config').get().m || 0;
  // auto_time só faz sentido em coluna de horário.
  const at = type === 'time' && ['start', 'end'].includes(autoTime) ? autoTime : null;
  db.prepare('INSERT INTO columns_config (id,name,type,field,built_in,is_deadline,width,sort_order,scope,parent_column_id,task_id,computed,auto_time,auto_time_source,board_id) VALUES(?,?,?,?,0,?,?,?,?,?,?,?,?,?,?)')
    .run(id, name, type, field, isDeadline ? 1 : 0, width || '80px', m + 1, scope || 'task', parentColumnId || null, taskId || null, computed || null, at, at ? (autoTimeSource || null) : null, board);
  res.json({ success: true });
});
app.put('/api/columns/:id',auth,(req,res)=>{const{name,isDeadline,width,type,parentColumnId,autoTime,autoTimeSource}=req.body;if(name)db.prepare('UPDATE columns_config SET name=? WHERE id=?').run(name,req.params.id);if(isDeadline!==undefined)db.prepare('UPDATE columns_config SET is_deadline=? WHERE id=?').run(isDeadline?1:0,req.params.id);if(width)db.prepare('UPDATE columns_config SET width=? WHERE id=?').run(width,req.params.id);
  // Trocar o tipo para algo que não seja horário desliga o automático junto.
  if(type){db.prepare('UPDATE columns_config SET type=? WHERE id=?').run(type,req.params.id);if(type!=='time')db.prepare('UPDATE columns_config SET auto_time=NULL, auto_time_source=NULL WHERE id=?').run(req.params.id);}
  if(autoTime!==undefined){const at=['start','end'].includes(autoTime)?autoTime:null;db.prepare("UPDATE columns_config SET auto_time=?, auto_time_source=? WHERE id=? AND type='time'").run(at,at?(autoTimeSource||null):null,req.params.id);}
  else if(autoTimeSource!==undefined)db.prepare("UPDATE columns_config SET auto_time_source=? WHERE id=? AND type='time'").run(autoTimeSource||null,req.params.id);
  if(parentColumnId!==undefined)db.prepare('UPDATE columns_config SET parent_column_id=? WHERE id=?').run(parentColumnId||null,req.params.id);res.json({success:true});});
app.delete('/api/columns/:id',auth,adminOnly,(req,res)=>{
  const colId=req.params.id;
  const c=db.prepare('SELECT built_in FROM columns_config WHERE id=?').get(colId);
  if(c?.built_in)return res.status(400).json({error:'Não pode excluir nativa'});
  const tx=db.transaction(()=>{
    db.prepare('DELETE FROM columns_config WHERE id=?').run(colId);
    // Horários que observavam esta coluna de status ficam sem origem. Desligar o
    // automático e avisar pelo silêncio da coluna é melhor que deixá-los cair no
    // status nativo sem ninguém perceber.
    db.prepare('UPDATE columns_config SET auto_time=NULL, auto_time_source=NULL WHERE auto_time_source=?').run(colId);
    const updTask=db.prepare('UPDATE tasks SET custom=? WHERE id=?');
    for(const t of db.prepare('SELECT id, custom FROM tasks').all()){
      try{
        const cust=JSON.parse(t.custom||'{}');
        let changed=false;
        if(colId in cust){delete cust[colId];changed=true;}
        if(Array.isArray(cust.hiddenSubCols)&&cust.hiddenSubCols.includes(colId)){
          cust.hiddenSubCols=cust.hiddenSubCols.filter(x=>x!==colId);
          changed=true;
        }
        if(changed)updTask.run(JSON.stringify(cust),t.id);
      }catch{}
    }
    const updSub=db.prepare('UPDATE subitems SET custom=? WHERE id=?');
    for(const s of db.prepare('SELECT id, custom FROM subitems').all()){
      try{
        const cust=JSON.parse(s.custom||'{}');
        if(colId in cust){delete cust[colId];updSub.run(JSON.stringify(cust),s.id);}
      }catch{}
    }
  });
  tx();
  res.json({success:true});
});

app.get('/api/automations', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM automations').all();
  res.json(rows.map(a => ({
    id: a.id,
    name: a.name,
    desc: a.description,
    icon: a.icon,
    active: !!a.active,
    builtIn: !!a.built_in,
    ruleConfig: a.rule_config ? JSON.parse(a.rule_config) : null,
    naturalPrompt: a.natural_prompt || null,
    createdBy: a.created_by || null,
    lastRunAt: a.last_run_at || null,
    lastRunStatus: a.last_run_status || null,
  })));
});

app.put('/api/automations/:id', auth, canManageAutomations, (req, res) => {
  const { active } = req.body;
  db.prepare('UPDATE automations SET active=? WHERE id=?').run(active ? 1 : 0, req.params.id);
  res.json({ success: true });
});

// Simple in-memory per-user rate limit for parser calls (protects Gemini free tier).
const _parseRate = new Map();
function checkParseRate(userId) {
  const now = Date.now();
  const LIMIT = 20;
  const WINDOW = 24 * 60 * 60 * 1000;
  const rec = _parseRate.get(userId);
  if (!rec || now > rec.resetAt) {
    _parseRate.set(userId, { count: 1, resetAt: now + WINDOW });
    return true;
  }
  if (rec.count >= LIMIT) return false;
  rec.count++;
  return true;
}

app.post('/api/automations', auth, canManageAutomations, async (req, res) => {
  // Dois caminhos de criação:
  //  1. "rule" estruturada (formato guiado no front) → validada direto, SEM Gemini.
  //  2. "description" em texto livre → interpretada pelo Gemini (sujeita a cota/rate limit).
  const { description, name, icon, rule: providedRule } = req.body;
  const usingGuided = providedRule && typeof providedRule === 'object';

  if (!usingGuided) {
    if (!description || typeof description !== 'string') return res.status(400).json({ error: 'description obrigatório' });
    if (!checkParseRate(req.user.id)) return res.status(429).json({ error: 'Limite diário de criação atingido (20/dia)' });
  }

  try {
    const columns = db.prepare('SELECT * FROM columns_config').all().map(c => ({
      id: c.id, name: c.name, type: c.type, field: c.field,
      scope: c.scope || 'task', parent_column_id: c.parent_column_id, task_id: c.task_id,
    }));
    const users = db.prepare('SELECT id, name FROM users').all();

    let rule;
    let naturalPrompt = (typeof description === 'string' && description.trim()) ? description.trim() : null;

    if (usingGuided) {
      rule = providedRule;
      if (rule.taskId === '' || rule.taskId === undefined) rule.taskId = null;
      // Normaliza nomes de destinatários para o nome exato cadastrado (igual ao parser).
      if (rule.type === 'notify' && Array.isArray(rule.recipients) && users.length) {
        const userByLower = new Map(users.map(u => [u.name.toLowerCase(), u.name]));
        rule.recipients = rule.recipients
          .map(r => userByLower.get(String(r).toLowerCase().replace(/^@/, '')) || r)
          .filter(r => userByLower.has(r.toLowerCase()));
        if (rule.recipients.length === 0) return res.status(400).json({ error: 'Selecione ao menos um destinatário válido' });
      }
      const errors = validateRule(rule, columns);
      if (errors.length) return res.status(400).json({ error: `Regra inválida: ${errors.join('; ')}` });
      if (!naturalPrompt) naturalPrompt = 'Automação (formato guiado)';
    } else {
      rule = await parseAutomation({ description, columns, users });
    }

    const id = 'auto_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const displayName = (name && name.trim()) || (naturalPrompt || '').slice(0, 60) || 'Automação';
    const displayIcon = icon || (usingGuided && rule.type === 'notify' ? '🔔' : '✨');
    db.prepare(`INSERT INTO automations (id, name, description, icon, active, rule_config, natural_prompt, created_by, built_in)
                VALUES (?, ?, ?, ?, 1, ?, ?, ?, 0)`)
      .run(id, displayName, `Automação personalizada`, displayIcon, JSON.stringify(rule), naturalPrompt, req.user.name);
    res.json({ id, name: displayName, icon: displayIcon, active: true, builtIn: false, ruleConfig: rule, naturalPrompt, createdBy: req.user.name });
  } catch (e) {
    console.error('Automation parse error:', e.message);
    const msg = e.message || '';
    const isQuota = /429|RESOURCE_EXHAUSTED|quota|Limite local/i.test(msg);
    res.status(isQuota ? 429 : 400).json({ error: msg });
  }
});

app.post('/api/automations/:id/run', auth, canManageAutomations, (req, res) => {
  const row = db.prepare('SELECT * FROM automations WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Automação não encontrada' });
  if (!row.rule_config) return res.status(400).json({ error: 'Esta automação é apenas placeholder e não pode ser executada' });
  let rule;
  try { rule = JSON.parse(row.rule_config); } catch { return res.status(500).json({ error: 'rule_config corrompido' }); }

  const columns = db.prepare('SELECT * FROM columns_config').all().map(c => ({
    id: c.id, name: c.name, type: c.type, field: c.field,
    scope: c.scope || 'task', parentColumnId: c.parent_column_id, taskId: c.task_id,
  }));
  const vErrors = validateRule(rule, columns);
  if (vErrors.length) return res.status(400).json({ error: `Regra inválida: ${vErrors.join('; ')}` });

  const result = executeAutomation({ db, rule, ruleId: req.params.id });
  const status = result.errors.length ? `erro: ${result.errors[0]}` : `ok (${result.applied})`;
  db.prepare('UPDATE automations SET last_run_at=CURRENT_TIMESTAMP, last_run_status=? WHERE id=?').run(status, req.params.id);
  if (result.errors.length) return res.status(400).json({ error: result.errors[0] });
  res.json(result);
});

app.delete('/api/automations/:id', auth, canManageAutomations, (req, res) => {
  const row = db.prepare('SELECT built_in FROM automations WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Não encontrada' });
  if (row.built_in) return res.status(400).json({ error: 'Automações nativas não podem ser excluídas' });
  db.prepare('DELETE FROM automations WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/admin/gemini-health', auth, canManageAutomations, async (req, res) => {
  const result = await geminiHealthCheck();
  res.json({ ...result, quota: geminiQuotaStatus() });
});

// ===== Daily snapshots report (admin only) =====
// Returns snapshots for the given period, aggregated totals, and per-user performance.
// Query params: period=day|week|month|year (default day), date=YYYY-MM-DD (default today BRT).
app.get('/api/reports', auth, adminOnly, (req, res) => {
  try { runDailyRollover(); } catch {}
  const period = ['day','week','month','year'].includes(req.query.period) ? req.query.period : 'day';
  const ref = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : brtDateString();
  const [y,m,d] = ref.split('-').map(Number);
  const refDate = new Date(Date.UTC(y, m-1, d));
  let start, end;
  if (period === 'day') { start = end = ref; }
  else if (period === 'week') {
    const dow = refDate.getUTCDay(); // 0=Sun
    const mondayOffset = dow === 0 ? -6 : 1 - dow;
    const s = new Date(refDate); s.setUTCDate(s.getUTCDate() + mondayOffset);
    const e = new Date(s); e.setUTCDate(e.getUTCDate() + 6);
    start = s.toISOString().slice(0,10); end = e.toISOString().slice(0,10);
  } else if (period === 'month') {
    start = `${ref.slice(0,7)}-01`;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    end = `${ref.slice(0,7)}-${String(lastDay).padStart(2,'0')}`;
  } else {
    start = `${ref.slice(0,4)}-01-01`; end = `${ref.slice(0,4)}-12-31`;
  }
  // Relatório é por quadro: sem boardId volta o consolidado de todos, com
  // boardId volta só o daquele quadro.
  const boardId = req.query.boardId || null;
  if (boardId && !db.prepare('SELECT id FROM boards WHERE id=?').get(boardId)) {
    return res.status(404).json({ error: 'Quadro não encontrado' });
  }
  const rows = boardId
    ? db.prepare('SELECT * FROM daily_snapshots WHERE date >= ? AND date <= ? AND board_id = ? ORDER BY date, task_id, subitem_id, column_id').all(start, end, boardId)
    : db.prepare('SELECT * FROM daily_snapshots WHERE date >= ? AND date <= ? ORDER BY date, task_id, subitem_id, column_id').all(start, end);

  const byDay = {};
  const perUser = {};
  const perTask = {};
  let total = 0;
  for (const r of rows) {
    const v = Number(r.value) || 0;
    total += v;
    if (!byDay[r.date]) byDay[r.date] = 0;
    byDay[r.date] += v;
    const key = r.task_id + '|' + r.subitem_id + '|' + r.column_id;
    if (!perTask[key]) perTask[key] = { task_id: r.task_id, subitem_id: r.subitem_id, column_id: r.column_id, task_name: r.task_name, subitem_name: r.subitem_name, column_name: r.column_name, value: 0 };
    perTask[key].value += v;
    let resp = [];
    try { resp = JSON.parse(r.responsible || '[]'); } catch {}
    if (!resp.length) {
      perUser['— Sem responsável'] = (perUser['— Sem responsável'] || 0) + v;
    } else {
      // Divide equally among co-responsibles so totals don't double-count.
      const share = v / resp.length;
      for (const name of resp) perUser[name] = (perUser[name] || 0) + share;
    }
  }
  res.json({
    period, date: ref, start, end,
    boardId,
    boardName: boardId ? (db.prepare('SELECT name FROM boards WHERE id=?').get(boardId)?.name || null) : null,
    total,
    byDay: Object.entries(byDay).map(([date,value]) => ({ date, value })).sort((a,b) => a.date.localeCompare(b.date)),
    perUser: Object.entries(perUser).map(([name,value]) => ({ name, value: Math.round(value*100)/100 })).sort((a,b) => b.value - a.value),
    perTask: Object.values(perTask).sort((a,b) => b.value - a.value),
    lastRolloverDate: db.prepare("SELECT value FROM settings WHERE key='last_rollover_date'").get()?.value || null
  });
});

// Auth fallback: a static token (env BACKUP_TOKEN) lets external schedulers (GH Actions
// cron) hit the backup endpoint without a JWT. If the header is absent or wrong, we
// fall through to the standard JWT+admin path so the admin UI still works as before.
function backupAuth(req, res, next) {
  const headerToken = req.headers['x-backup-token'];
  if (BACKUP_TOKEN && headerToken && headerToken === BACKUP_TOKEN) return next();
  return auth(req, res, () => adminOnly(req, res, next));
}
// O banco roda em modo WAL: as gravações recentes vivem no arquivo -wal, não
// dentro do .sqlite. Enviar DB_PATH direto entrega um banco praticamente vazio
// (4 KB, sem tabelas) — foi o que este endpoint fez até aqui. A API .backup()
// do SQLite gera uma cópia consistente, já com o WAL aplicado.
app.get('/api/admin/backup', backupAuth, (req, res) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tmp = path.join(path.dirname(DB_PATH), `backup-tmp-${Date.now()}-${process.pid}.sqlite`);
  try {
    // Descarrega o WAL dentro do .sqlite e só então copia: o arquivo passa a
    // conter tudo. (Sem isto o download saía com 4 KB e nenhuma tabela.)
    db.pragma('wal_checkpoint(TRUNCATE)');
    fs.copyFileSync(DB_PATH, tmp);

    // Nunca entregar um backup quebrado: confere se a cópia abre e tem dados.
    const conferencia = new Database(tmp, { readonly: true });
    const tabelas = conferencia.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().c;
    const usuarios = conferencia.prepare('SELECT COUNT(*) c FROM users').get().c;
    conferencia.close();
    if (!tabelas || !usuarios) throw new Error(`cópia inconsistente (${tabelas} tabelas, ${usuarios} usuários)`);

    res.download(tmp, `database.backup-${stamp}.sqlite`, () => limparTemp(tmp));
  } catch (e) {
    limparTemp(tmp);
    console.error('Backup err:', e.message);
    res.status(500).json({ error: 'Falha ao gerar o backup: ' + e.message });
  }
});

// Abrir a cópia para conferir cria -wal e -shm ao lado dela; os três somem juntos.
function limparTemp(base) {
  for (const f of [base, `${base}-wal`, `${base}-shm`]) {
    try { fs.unlinkSync(f); } catch {}
  }
}
// Sobras de um download interrompido não ficam acumulando na pasta do banco.
(function limparTempAntigos() {
  try {
    const dir = path.dirname(DB_PATH);
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith('backup-tmp-')) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
    }
  } catch {}
})();

// Upload de anexos. Retorna metadata (id, name, mime, size) que o cliente
// guarda em updates.files. Os bytes ficam em UPLOAD_DIR/<id>.
app.post('/api/upload', auth, (req, res) => {
  uploadHandler.array('files', 10)(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Arquivo excede o limite de 10 MB' : err.message;
      return res.status(400).json({ error: msg });
    }
    try {
      const out = (req.files || []).map(f => {
        const meta = {
          name: f.originalname,
          mime: f.mimetype,
          size: f.size,
          uploadedAt: new Date().toISOString(),
          uploadedBy: req.user.name,
        };
        fs.writeFileSync(path.join(UPLOAD_DIR, f.filename + '.json'), JSON.stringify(meta));
        return { id: f.filename, name: f.originalname, mime: f.mimetype, size: f.size };
      });
      res.json({ success: true, files: out });
    } catch (e) {
      res.status(500).json({ error: 'Falha ao salvar upload: ' + e.message });
    }
  });
});

// Servir anexo. Por padrao inline (browser abre se souber renderizar).
// ?download=1 forca attachment.
app.get('/api/files/:id', authFile, (req, res) => {
  const id = req.params.id;
  if (!/^[a-f0-9]{24}$/.test(id)) return res.status(400).json({ error: 'ID inválido' });
  const filePath = path.join(UPLOAD_DIR, id);
  const metaPath = filePath + '.json';
  if (!fs.existsSync(filePath) || !fs.existsSync(metaPath)) {
    return res.status(404).json({ error: 'Arquivo não encontrado' });
  }
  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); }
  catch { return res.status(500).json({ error: 'Metadados corrompidos' }); }
  res.setHeader('Content-Type', meta.mime || 'application/octet-stream');
  const dispoType = req.query.download === '1' ? 'attachment' : 'inline';
  const safeName = encodeURIComponent(meta.name || id);
  res.setHeader('Content-Disposition', `${dispoType}; filename*=UTF-8''${safeName}`);
  res.sendFile(filePath);
});

// One-shot admin: zera a tabela `updates` (relatorios/mensagens do quadro).
// Faz backup do DB para BACKUP_DIR antes de deletar. Operacao irreversivel.
app.post('/api/admin/wipe-updates', auth, adminOnly, async (req, res) => {
  try {
    const count = db.prepare('SELECT COUNT(*) AS c FROM updates').get().c;
    if (req.query.dry === '1') return res.json({ success: true, count, dryRun: true });
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(BACKUP_DIR, `database.pre-wipe-${stamp}.sqlite`);
    await db.backup(dest);
    db.prepare('DELETE FROM updates').run();
    res.json({ success: true, deleted: count, backup: path.basename(dest) });
  } catch (e) {
    res.status(500).json({ error: 'Falha ao limpar: ' + e.message });
  }
});

if(process.env.NODE_ENV==='production'){app.use(express.static(path.join(__dirname,'../client/build')));app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'../client/build/index.html')));}

app.listen(PORT,()=>console.log(`🚀 Server running on port ${PORT}`));
