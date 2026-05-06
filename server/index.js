require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { parseAutomation, healthCheck: geminiHealthCheck } = require('./automations/parser');
const { execute: executeAutomation } = require('./automations/executor');
const { validateRule } = require('./automations/schema');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'rotina-escritorio-secret-2026';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const BACKUP_TOKEN = process.env.BACKUP_TOKEN || '';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'database.sqlite');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
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
    deadline TEXT, custom TEXT DEFAULT '{}', sort_order INTEGER DEFAULT 0,
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
    PRIMARY KEY (date, task_id, subitem_id, column_id)
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT
  );
`);

// Non-destructive migration: add scope/parent_column_id to existing databases
(function migrateColumnsConfig() {
  const cols = db.prepare("PRAGMA table_info(columns_config)").all().map(c => c.name);
  if (!cols.includes('scope')) db.exec("ALTER TABLE columns_config ADD COLUMN scope TEXT DEFAULT 'task'");
  if (!cols.includes('parent_column_id')) db.exec("ALTER TABLE columns_config ADD COLUMN parent_column_id TEXT");
  if (!cols.includes('task_id')) db.exec("ALTER TABLE columns_config ADD COLUMN task_id TEXT");
  if (!cols.includes('computed')) db.exec("ALTER TABLE columns_config ADD COLUMN computed TEXT");
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
  const iu = db.prepare('INSERT INTO users (name,email,password,role,avatar_color) VALUES (?,?,?,?,?)');
  [['Gabriela','gabriela@rotina.com',hash,'collaborator','#ff642e'],['Camila','camila@rotina.com',hash,'collaborator','#fdab3d'],
   ['Junior','junior@rotina.com',hash,'admin','#a25ddc'],['Ana','ana@rotina.com',hash,'collaborator','#00c875'],
   ['Pedro','pedro@rotina.com',hash,'collaborator','#579bfc'],['Lucas','lucas@rotina.com',hash,'collaborator','#e2445c']].forEach(u=>iu.run(...u));

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
function brtDateString(d = new Date()) {
  const utcMs = d.getTime() + d.getTimezoneOffset() * 60000;
  const brt = new Date(utcMs - 3 * 3600000);
  return brt.toISOString().slice(0, 10);
}

function runDailyRollover() {
  const today = brtDateString();
  const row = db.prepare("SELECT value FROM settings WHERE key='last_rollover_date'").get();
  const last = row?.value;
  if (last === today) return;
  // First run ever: just record today, nothing to snapshot.
  if (!last) {
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('last_rollover_date',?)").run(today);
    return;
  }
  const numericSubCols = db.prepare(
    "SELECT id, name, task_id FROM columns_config WHERE scope='subitem' AND type='number' AND (computed IS NULL OR computed='')"
  ).all();
  const tasks = db.prepare('SELECT id, name, total_orders, total_cancellations, responsible FROM tasks').all();
  const taskById = new Map(tasks.map(t => [t.id, t]));
  const subitems = db.prepare('SELECT id, task_id, name, total, custom, responsible FROM subitems').all();

  const insSnap = db.prepare(
    `INSERT OR REPLACE INTO daily_snapshots
     (date, task_id, subitem_id, column_id, value, responsible, task_name, subitem_name, column_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const updSub = db.prepare('UPDATE subitems SET total=0, custom=? WHERE id=?');
  const updTask = db.prepare('UPDATE tasks SET total_orders=0, total_cancellations=0 WHERE id=?');

  const tx = db.transaction(() => {
    // Snapshot + zero subitem numeric columns
    for (const s of subitems) {
      const t = taskById.get(s.task_id);
      const taskName = t?.name || '';
      const resp = s.responsible || '[]';
      let custom = {};
      try { custom = JSON.parse(s.custom || '{}'); } catch {}
      // Built-in `total` field
      if (s.total && Number(s.total) !== 0) {
        insSnap.run(last, s.task_id, s.id, '__total__', Number(s.total), resp, taskName, s.name, 'TOTAL');
      }
      let customChanged = false;
      for (const col of numericSubCols) {
        // Per-task scoped columns only snapshot for their own task
        if (col.task_id && col.task_id !== s.task_id) continue;
        const v = custom[col.id];
        const num = typeof v === 'number' ? v : (v != null && v !== '' ? Number(v) : 0);
        if (num && !Number.isNaN(num)) {
          insSnap.run(last, s.task_id, s.id, col.id, num, resp, taskName, s.name, col.name);
        }
        if (col.id in custom) { delete custom[col.id]; customChanged = true; }
      }
      if ((s.total && Number(s.total) !== 0) || customChanged) {
        updSub.run(JSON.stringify(custom), s.id);
      }
    }
    // Snapshot + zero task totals
    for (const t of tasks) {
      if (t.total_orders && Number(t.total_orders) !== 0) {
        insSnap.run(last, t.id, '', 'totalOrders', Number(t.total_orders), t.responsible || '[]', t.name, '', 'Pedidos');
      }
      if (t.total_cancellations && Number(t.total_cancellations) !== 0) {
        insSnap.run(last, t.id, '', 'totalCancellations', Number(t.total_cancellations), t.responsible || '[]', t.name, '', 'Canc.');
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

function auth(req,res,next){const t=req.headers.authorization?.split(' ')[1];if(!t)return res.status(401).json({error:'Token necessário'});try{req.user=jwt.verify(t,JWT_SECRET);next();}catch{return res.status(401).json({error:'Token inválido'});}}
function adminOnly(req,res,next){if(req.user.role!=='admin')return res.status(403).json({error:'Acesso restrito'});next();}

app.post('/api/auth/login',(req,res)=>{const{email,password}=req.body;const u=db.prepare('SELECT * FROM users WHERE email=?').get(email?.toLowerCase?.());if(!u||!bcrypt.compareSync(password,u.password))return res.status(401).json({error:'Credenciais inválidas'});const token=jwt.sign({id:u.id,name:u.name,email:u.email,role:u.role},JWT_SECRET,{expiresIn:'7d'});res.json({token,user:{id:u.id,name:u.name,email:u.email,role:u.role,phone:u.phone,department:u.department,bio:u.bio,avatar_color:u.avatar_color}});});

// Public self-registration. New users default to 'collaborator' and must be
// promoted to 'admin' by an existing admin via /api/users/:id/role.
app.post('/api/auth/register', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Nome, email e senha são obrigatórios' });
  const trimmedName = String(name).trim();
  const em = String(email).toLowerCase().trim();
  if (trimmedName.length < 2) return res.status(400).json({ error: 'Nome muito curto' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return res.status(400).json({ error: 'Email inválido' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres' });
  if (db.prepare('SELECT id FROM users WHERE email=?').get(em)) return res.status(409).json({ error: 'Email já cadastrado' });
  const colors = ['#ff642e','#fdab3d','#a25ddc','#00c875','#579bfc','#e2445c','#6c5ce7','#00ced1','#ff158a','#037f4c'];
  const color = colors[Math.floor(Math.random() * colors.length)];
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users (name,email,password,role,avatar_color) VALUES (?,?,?,?,?)')
    .run(trimmedName, em, hash, 'collaborator', color);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
  const token = jwt.sign({ id: u.id, name: u.name, email: u.email, role: u.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: u.id, name: u.name, email: u.email, role: u.role, phone: u.phone || '', department: u.department || '', bio: u.bio || '', avatar_color: u.avatar_color } });
});

// Google OAuth - verify token and create/login user
app.post('/api/auth/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'Token Google ausente' });
  try {
    // Decode the JWT from Google (the ID token)
    const parts = credential.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    const { email, name, picture, sub: googleId } = payload;
    if (!email) return res.status(400).json({ error: 'Email não encontrado no token' });
    
    // Check if user exists
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
    
    if (!user) {
      // Create new user from Google account
      const colors = ['#ff642e','#fdab3d','#a25ddc','#00c875','#579bfc','#e2445c','#ff158a','#037f4c'];
      const color = colors[Math.floor(Math.random() * colors.length)];
      const hash = bcrypt.hashSync('google_' + googleId + '_' + Date.now(), 10);
      db.prepare('INSERT INTO users (name, email, password, role, avatar_color) VALUES (?,?,?,?,?)')
        .run(name || email.split('@')[0], email.toLowerCase(), hash, 'collaborator', color);
      user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
    }
    
    const token = jwt.sign({ id: user.id, name: user.name, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, phone: user.phone || '', department: user.department || '', bio: user.bio || '', avatar_color: user.avatar_color || '#888' } });
  } catch (err) {
    console.error('Google auth error:', err.message);
    res.status(401).json({ error: 'Token Google inválido' });
  }
});
app.get('/api/auth/me',auth,(req,res)=>{const u=db.prepare('SELECT id,name,email,role,phone,department,bio,avatar_color,created_at FROM users WHERE id=?').get(req.user.id);if(!u)return res.status(404).json({error:'Não encontrado'});res.json(u);});

// Public config endpoint (no auth needed)
app.get('/api/config', (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID });
});

app.get('/api/users',auth,(req,res)=>res.json(db.prepare('SELECT id,name,email,role,phone,department,bio,avatar_color FROM users ORDER BY name').all()));
app.post('/api/users',auth,adminOnly,(req,res)=>{
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Nome, email e senha são obrigatórios' });
  if (password.length < 4) return res.status(400).json({ error: 'Senha deve ter pelo menos 4 caracteres' });
  const em = email.toLowerCase().trim();
  if (db.prepare('SELECT id FROM users WHERE email=?').get(em)) return res.status(409).json({ error: 'Email já cadastrado' });
  const r = role === 'admin' ? 'admin' : 'collaborator';
  const colors = ['#ff642e','#fdab3d','#a25ddc','#00c875','#579bfc','#e2445c','#6c5ce7','#00ced1'];
  const color = colors[Math.floor(Math.random() * colors.length)];
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users (name,email,password,role,avatar_color) VALUES (?,?,?,?,?)').run(name.trim(), em, hash, r, color);
  res.json(db.prepare('SELECT id,name,email,role,phone,department,bio,avatar_color FROM users WHERE id=?').get(info.lastInsertRowid));
});
app.delete('/api/users/:id',auth,adminOnly,(req,res)=>{
  const id = parseInt(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Não pode excluir a si mesmo' });
  const target = db.prepare('SELECT role FROM users WHERE id=?').get(id);
  if (!target) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (target.role === 'admin') {
    const ac = db.prepare("SELECT COUNT(*) as c FROM users WHERE role='admin'").get().c;
    if (ac <= 1) return res.status(400).json({ error: 'Precisa de pelo menos 1 administrador' });
  }
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  res.json({ success: true });
});
app.put('/api/users/:id',auth,(req,res)=>{const{id}=req.params;if(req.user.id!==parseInt(id)&&req.user.role!=='admin')return res.status(403).json({error:'Sem permissão'});const{name,email,phone,department,bio,avatar_color,password}=req.body;const u=[];const p=[];if(name){u.push('name=?');p.push(name);}if(email){u.push('email=?');p.push(email.toLowerCase());}if(phone!==undefined){u.push('phone=?');p.push(phone);}if(department!==undefined){u.push('department=?');p.push(department);}if(bio!==undefined){u.push('bio=?');p.push(bio);}if(avatar_color){u.push('avatar_color=?');p.push(avatar_color);}if(password){u.push('password=?');p.push(bcrypt.hashSync(password,10));}if(!u.length)return res.status(400).json({error:'Nada para atualizar'});p.push(id);db.prepare(`UPDATE users SET ${u.join(',')} WHERE id=?`).run(...p);res.json(db.prepare('SELECT id,name,email,role,phone,department,bio,avatar_color FROM users WHERE id=?').get(id));});
app.put('/api/users/:id/role',auth,adminOnly,(req,res)=>{const{role}=req.body;if(!['admin','collaborator'].includes(role))return res.status(400).json({error:'Cargo inválido'});const ac=db.prepare("SELECT COUNT(*) as c FROM users WHERE role='admin'").get().c;const t=db.prepare('SELECT role FROM users WHERE id=?').get(req.params.id);if(t?.role==='admin'&&role!=='admin'&&ac<=1)return res.status(400).json({error:'Precisa de 1 admin'});db.prepare('UPDATE users SET role=? WHERE id=?').run(role,req.params.id);res.json({success:true});});

// ===== Folders =====
app.get('/api/folders', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM board_folders ORDER BY sort_order, created_at').all();
  res.json(rows.map(f => ({ id: f.id, name: f.name, icon: f.icon, color: f.color, sortOrder: f.sort_order, createdAt: f.created_at })));
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
app.get('/api/boards', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM boards ORDER BY sort_order, created_at').all();
  res.json(rows.map(b => ({ id: b.id, name: b.name, icon: b.icon, color: b.color, sortOrder: b.sort_order, folderId: b.folder_id, createdAt: b.created_at })));
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
  const { name, icon, color, folderId } = req.body || {};
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
  if (!upd.length) return res.status(400).json({ error: 'Nada para atualizar' });
  params.push(req.params.id);
  db.prepare(`UPDATE boards SET ${upd.join(',')} WHERE id=?`).run(...params);
  const row = db.prepare('SELECT * FROM boards WHERE id=?').get(req.params.id);
  res.json({ id: row.id, name: row.name, icon: row.icon, color: row.color, sortOrder: row.sort_order, folderId: row.folder_id, createdAt: row.created_at });
});

app.put('/api/boards/reorder', auth, adminOnly, (req, res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order deve ser array' });
  const upd = db.prepare('UPDATE boards SET sort_order=? WHERE id=?');
  const tx = db.transaction((ids) => { ids.forEach((id, i) => upd.run(i, id)); });
  tx(order);
  res.json({ success: true });
});

app.delete('/api/boards/:id', auth, adminOnly, (req, res) => {
  const id = req.params.id;
  const total = db.prepare('SELECT COUNT(*) as c FROM boards').get().c;
  if (total <= 1) return res.status(400).json({ error: 'Não é possível excluir o último quadro' });
  if (!db.prepare('SELECT id FROM boards WHERE id=?').get(id)) return res.status(404).json({ error: 'Quadro não encontrado' });
  const tx = db.transaction(() => {
    // Cascade: subitems via FK ON DELETE CASCADE on tasks. Delete columns + tasks explicitly.
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
      total: s.total, deadline: s.deadline, custom: JSON.parse(s.custom), cancellations: 0,
      updates: ups.filter(u => u.target_type === 'subitem' && u.target_id === s.id).map(u => ({ id: u.id, author: u.author, text: u.text, mentions: JSON.parse(u.mentions), files: JSON.parse(u.files), time: u.created_at }))
    })),
    updates: ups.filter(u => u.target_type === 'task' && u.target_id === t.id).map(u => ({ id: u.id, author: u.author, text: u.text, mentions: JSON.parse(u.mentions), files: JSON.parse(u.files), time: u.created_at }))
  })));
});
app.post('/api/tasks',auth,(req,res)=>{
  const { id, name, status, priority, deadline, responsible, totalOrders, totalCancellations, custom, boardId } = req.body;
  const board = boardId || 'board_operacoes';
  if (!db.prepare('SELECT id FROM boards WHERE id=?').get(board)) return res.status(400).json({ error: 'Quadro inválido' });
  const m = db.prepare('SELECT MAX(sort_order) as m FROM tasks WHERE board_id=?').get(board).m || 0;
  db.prepare('INSERT INTO tasks (id,name,status,priority,deadline,responsible,total_orders,total_cancellations,custom,sort_order,board_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, name, status || 'Não iniciado', priority || 'Média', deadline || null, JSON.stringify(responsible || []), totalOrders || 0, totalCancellations || 0, JSON.stringify(custom || {}), m + 1, board);
  res.json({ success: true });
});
app.put('/api/tasks/:id',auth,(req,res)=>{const{name,status,priority,deadline,responsible,totalOrders,totalCancellations,custom}=req.body;const t=db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);if(!t)return res.status(404).json({error:'Não encontrada'});db.prepare('UPDATE tasks SET name=?,status=?,priority=?,deadline=?,responsible=?,total_orders=?,total_cancellations=?,custom=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(name??t.name,status??t.status,priority??t.priority,deadline!==undefined?deadline:t.deadline,responsible?JSON.stringify(responsible):t.responsible,totalOrders??t.total_orders,totalCancellations??t.total_cancellations,custom?JSON.stringify(custom):t.custom,req.params.id);res.json({success:true});});
app.delete('/api/tasks/:id',auth,adminOnly,(req,res)=>{db.prepare('DELETE FROM tasks WHERE id=?').run(req.params.id);res.json({success:true});});

app.put('/api/subitems/:id',auth,(req,res)=>{const{name,owner,status,responsible,total,deadline,custom}=req.body;const s=db.prepare('SELECT * FROM subitems WHERE id=?').get(req.params.id);if(!s)return res.status(404).json({error:'Não encontrado'});db.prepare('UPDATE subitems SET name=?,owner=?,status=?,responsible=?,total=?,deadline=?,custom=? WHERE id=?').run(name??s.name,owner??s.owner,status??s.status,responsible?JSON.stringify(responsible):s.responsible,total??s.total,deadline!==undefined?deadline:s.deadline,custom?JSON.stringify(custom):s.custom,req.params.id);res.json({success:true});});
app.post('/api/subitems',auth,(req,res)=>{const{id,task_id,name,owner,status,responsible,total,deadline,custom}=req.body;const m=db.prepare('SELECT MAX(sort_order) as m FROM subitems WHERE task_id=?').get(task_id);db.prepare('INSERT INTO subitems (id,task_id,name,owner,status,responsible,total,deadline,custom,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,task_id,name||'Novo subitem',owner||'',status||'Não iniciado',JSON.stringify(responsible||[]),total||0,deadline||null,JSON.stringify(custom||{}),(m?.m||0)+1);res.json({success:true});});

app.post('/api/updates',auth,(req,res)=>{const{id,targetType,targetId,text,mentions,files}=req.body;db.prepare('INSERT INTO updates (id,target_type,target_id,author,text,mentions,files) VALUES(?,?,?,?,?,?,?)').run(id,targetType,targetId,req.user.name,text||'',JSON.stringify(mentions||[]),JSON.stringify(files||[]));res.json({success:true});});
app.delete('/api/updates/:id',auth,(req,res)=>{const u=db.prepare('SELECT author FROM updates WHERE id=?').get(req.params.id);if(!u)return res.status(404).json({error:'Relatório não encontrado'});if(u.author!==req.user.name&&req.user.role!=='admin')return res.status(403).json({error:'Apenas o autor pode excluir'});db.prepare('DELETE FROM updates WHERE id=?').run(req.params.id);res.json({success:true});});

app.get('/api/columns',auth,(req,res)=>{
  const boardId = req.query.boardId || null;
  const rows = boardId
    ? db.prepare('SELECT * FROM columns_config WHERE board_id=? ORDER BY sort_order').all(boardId)
    : db.prepare('SELECT * FROM columns_config ORDER BY sort_order').all();
  res.json(rows.map(c => ({ id: c.id, name: c.name, type: c.type, field: c.field, builtIn: !!c.built_in, isDeadline: !!c.is_deadline, width: c.width, scope: c.scope || 'task', parentColumnId: c.parent_column_id || null, taskId: c.task_id || null, computed: c.computed || null, boardId: c.board_id || 'board_operacoes' })));
});
app.put('/api/columns/reorder',auth,(req,res)=>{const{order}=req.body;if(!Array.isArray(order))return res.status(400).json({error:'order deve ser array'});const upd=db.prepare('UPDATE columns_config SET sort_order=? WHERE id=?');const tx=db.transaction((ids)=>{ids.forEach((id,i)=>upd.run(i,id));});tx(order);res.json({success:true});});
app.post('/api/columns',auth,(req,res)=>{
  const { id, name, type, field, isDeadline, width, scope, parentColumnId, taskId, computed, boardId } = req.body;
  const board = boardId || 'board_operacoes';
  if (!db.prepare('SELECT id FROM boards WHERE id=?').get(board)) return res.status(400).json({ error: 'Quadro inválido' });
  const m = db.prepare('SELECT MAX(sort_order) as m FROM columns_config').get().m || 0;
  db.prepare('INSERT INTO columns_config (id,name,type,field,built_in,is_deadline,width,sort_order,scope,parent_column_id,task_id,computed,board_id) VALUES(?,?,?,?,0,?,?,?,?,?,?,?,?)')
    .run(id, name, type, field, isDeadline ? 1 : 0, width || '80px', m + 1, scope || 'task', parentColumnId || null, taskId || null, computed || null, board);
  res.json({ success: true });
});
app.put('/api/columns/:id',auth,(req,res)=>{const{name,isDeadline,width,type,parentColumnId}=req.body;if(name)db.prepare('UPDATE columns_config SET name=? WHERE id=?').run(name,req.params.id);if(isDeadline!==undefined)db.prepare('UPDATE columns_config SET is_deadline=? WHERE id=?').run(isDeadline?1:0,req.params.id);if(width)db.prepare('UPDATE columns_config SET width=? WHERE id=?').run(width,req.params.id);if(type)db.prepare('UPDATE columns_config SET type=? WHERE id=?').run(type,req.params.id);if(parentColumnId!==undefined)db.prepare('UPDATE columns_config SET parent_column_id=? WHERE id=?').run(parentColumnId||null,req.params.id);res.json({success:true});});
app.delete('/api/columns/:id',auth,adminOnly,(req,res)=>{
  const colId=req.params.id;
  const c=db.prepare('SELECT built_in FROM columns_config WHERE id=?').get(colId);
  if(c?.built_in)return res.status(400).json({error:'Não pode excluir nativa'});
  const tx=db.transaction(()=>{
    db.prepare('DELETE FROM columns_config WHERE id=?').run(colId);
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

app.put('/api/automations/:id', auth, adminOnly, (req, res) => {
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

app.post('/api/automations', auth, adminOnly, async (req, res) => {
  const { description, name, icon } = req.body;
  if (!description || typeof description !== 'string') return res.status(400).json({ error: 'description obrigatório' });
  if (!checkParseRate(req.user.id)) return res.status(429).json({ error: 'Limite diário de criação atingido (20/dia)' });
  try {
    const columns = db.prepare('SELECT * FROM columns_config').all().map(c => ({
      id: c.id, name: c.name, type: c.type, field: c.field,
      scope: c.scope || 'task', parent_column_id: c.parent_column_id, task_id: c.task_id,
    }));
    const rule = await parseAutomation({ description, columns });
    const id = 'auto_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const displayName = (name && name.trim()) || description.slice(0, 60);
    const displayIcon = icon || '✨';
    db.prepare(`INSERT INTO automations (id, name, description, icon, active, rule_config, natural_prompt, created_by, built_in)
                VALUES (?, ?, ?, ?, 1, ?, ?, ?, 0)`)
      .run(id, displayName, `Automação personalizada`, displayIcon, JSON.stringify(rule), description, req.user.name);
    res.json({ id, name: displayName, icon: displayIcon, active: true, builtIn: false, ruleConfig: rule, naturalPrompt: description, createdBy: req.user.name });
  } catch (e) {
    console.error('Automation parse error:', e.message);
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/automations/:id/run', auth, adminOnly, (req, res) => {
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

  const result = executeAutomation({ db, rule });
  const status = result.errors.length ? `erro: ${result.errors[0]}` : `ok (${result.applied})`;
  db.prepare('UPDATE automations SET last_run_at=CURRENT_TIMESTAMP, last_run_status=? WHERE id=?').run(status, req.params.id);
  if (result.errors.length) return res.status(400).json({ error: result.errors[0] });
  res.json(result);
});

app.delete('/api/automations/:id', auth, adminOnly, (req, res) => {
  const row = db.prepare('SELECT built_in FROM automations WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Não encontrada' });
  if (row.built_in) return res.status(400).json({ error: 'Automações nativas não podem ser excluídas' });
  db.prepare('DELETE FROM automations WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/admin/gemini-health', auth, adminOnly, async (req, res) => {
  const result = await geminiHealthCheck();
  res.json(result);
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
  const rows = db.prepare(
    'SELECT * FROM daily_snapshots WHERE date >= ? AND date <= ? ORDER BY date, task_id, subitem_id, column_id'
  ).all(start, end);

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
app.get('/api/admin/backup', backupAuth, (req, res) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  res.download(DB_PATH, `database.backup-${stamp}.sqlite`);
});

if(process.env.NODE_ENV==='production'){app.use(express.static(path.join(__dirname,'../client/build')));app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'../client/build/index.html')));}

app.listen(PORT,()=>console.log(`🚀 Server running on port ${PORT}`));
