const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'rotina-escritorio-secret-2026';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const db = new Database(path.join(__dirname, 'database.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL, role TEXT DEFAULT 'collaborator', phone TEXT DEFAULT '',
    department TEXT DEFAULT '', bio TEXT DEFAULT '', avatar_color TEXT DEFAULT '#888',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT DEFAULT 'Não iniciado',
    priority TEXT DEFAULT 'Média', deadline TEXT, responsible TEXT DEFAULT '[]',
    total_orders INTEGER DEFAULT 0, total_cancellations INTEGER DEFAULT 0,
    custom TEXT DEFAULT '{}', sort_order INTEGER DEFAULT 0,
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
    built_in INTEGER DEFAULT 0, is_deadline INTEGER DEFAULT 0, width TEXT DEFAULT '80px', sort_order INTEGER DEFAULT 0
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
`);

function seedDatabase() {
  if (db.prepare('SELECT COUNT(*) as c FROM users').get().c > 0) return;
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

function auth(req,res,next){const t=req.headers.authorization?.split(' ')[1];if(!t)return res.status(401).json({error:'Token necessário'});try{req.user=jwt.verify(t,JWT_SECRET);next();}catch{return res.status(401).json({error:'Token inválido'});}}
function adminOnly(req,res,next){if(req.user.role!=='admin')return res.status(403).json({error:'Acesso restrito'});next();}

app.post('/api/auth/login',(req,res)=>{const{email,password}=req.body;const u=db.prepare('SELECT * FROM users WHERE email=?').get(email?.toLowerCase?.());if(!u||!bcrypt.compareSync(password,u.password))return res.status(401).json({error:'Credenciais inválidas'});const token=jwt.sign({id:u.id,name:u.name,email:u.email,role:u.role},JWT_SECRET,{expiresIn:'7d'});res.json({token,user:{id:u.id,name:u.name,email:u.email,role:u.role,phone:u.phone,department:u.department,bio:u.bio,avatar_color:u.avatar_color}});});

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
app.put('/api/users/:id',auth,(req,res)=>{const{id}=req.params;if(req.user.id!==parseInt(id)&&req.user.role!=='admin')return res.status(403).json({error:'Sem permissão'});const{name,email,phone,department,bio,avatar_color,password}=req.body;const u=[];const p=[];if(name){u.push('name=?');p.push(name);}if(email){u.push('email=?');p.push(email.toLowerCase());}if(phone!==undefined){u.push('phone=?');p.push(phone);}if(department!==undefined){u.push('department=?');p.push(department);}if(bio!==undefined){u.push('bio=?');p.push(bio);}if(avatar_color){u.push('avatar_color=?');p.push(avatar_color);}if(password){u.push('password=?');p.push(bcrypt.hashSync(password,10));}if(!u.length)return res.status(400).json({error:'Nada para atualizar'});p.push(id);db.prepare(`UPDATE users SET ${u.join(',')} WHERE id=?`).run(...p);res.json(db.prepare('SELECT id,name,email,role,phone,department,bio,avatar_color FROM users WHERE id=?').get(id));});
app.put('/api/users/:id/role',auth,adminOnly,(req,res)=>{const{role}=req.body;if(!['admin','collaborator'].includes(role))return res.status(400).json({error:'Cargo inválido'});const ac=db.prepare("SELECT COUNT(*) as c FROM users WHERE role='admin'").get().c;const t=db.prepare('SELECT role FROM users WHERE id=?').get(req.params.id);if(t?.role==='admin'&&role!=='admin'&&ac<=1)return res.status(400).json({error:'Precisa de 1 admin'});db.prepare('UPDATE users SET role=? WHERE id=?').run(role,req.params.id);res.json({success:true});});

app.get('/api/tasks',auth,(req,res)=>{const tasks=db.prepare('SELECT * FROM tasks ORDER BY sort_order').all();const subs=db.prepare('SELECT * FROM subitems ORDER BY sort_order').all();const ups=db.prepare('SELECT * FROM updates ORDER BY created_at').all();res.json(tasks.map(t=>({id:t.id,name:t.name,status:t.status,priority:t.priority,deadline:t.deadline,responsible:JSON.parse(t.responsible),totalOrders:t.total_orders,totalCancellations:t.total_cancellations,custom:JSON.parse(t.custom),subitems:subs.filter(s=>s.task_id===t.id).map(s=>({id:s.id,name:s.name,owner:s.owner,status:s.status,responsible:JSON.parse(s.responsible),total:s.total,deadline:s.deadline,custom:JSON.parse(s.custom),cancellations:0,updates:ups.filter(u=>u.target_type==='subitem'&&u.target_id===s.id).map(u=>({id:u.id,author:u.author,text:u.text,mentions:JSON.parse(u.mentions),files:JSON.parse(u.files),time:u.created_at}))})),updates:ups.filter(u=>u.target_type==='task'&&u.target_id===t.id).map(u=>({id:u.id,author:u.author,text:u.text,mentions:JSON.parse(u.mentions),files:JSON.parse(u.files),time:u.created_at}))})));});
app.post('/api/tasks',auth,(req,res)=>{const{id,name,status,priority,deadline,responsible,totalOrders,totalCancellations,custom}=req.body;const m=db.prepare('SELECT MAX(sort_order) as m FROM tasks').get().m||0;db.prepare('INSERT INTO tasks (id,name,status,priority,deadline,responsible,total_orders,total_cancellations,custom,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,name,status||'Não iniciado',priority||'Média',deadline||null,JSON.stringify(responsible||[]),totalOrders||0,totalCancellations||0,JSON.stringify(custom||{}),m+1);res.json({success:true});});
app.put('/api/tasks/:id',auth,(req,res)=>{const{name,status,priority,deadline,responsible,totalOrders,totalCancellations,custom}=req.body;const t=db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);if(!t)return res.status(404).json({error:'Não encontrada'});db.prepare('UPDATE tasks SET name=?,status=?,priority=?,deadline=?,responsible=?,total_orders=?,total_cancellations=?,custom=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(name??t.name,status??t.status,priority??t.priority,deadline!==undefined?deadline:t.deadline,responsible?JSON.stringify(responsible):t.responsible,totalOrders??t.total_orders,totalCancellations??t.total_cancellations,custom?JSON.stringify(custom):t.custom,req.params.id);res.json({success:true});});
app.delete('/api/tasks/:id',auth,adminOnly,(req,res)=>{db.prepare('DELETE FROM tasks WHERE id=?').run(req.params.id);res.json({success:true});});

app.put('/api/subitems/:id',auth,(req,res)=>{const{name,owner,status,responsible,total,deadline,custom}=req.body;const s=db.prepare('SELECT * FROM subitems WHERE id=?').get(req.params.id);if(!s)return res.status(404).json({error:'Não encontrado'});db.prepare('UPDATE subitems SET name=?,owner=?,status=?,responsible=?,total=?,deadline=?,custom=? WHERE id=?').run(name??s.name,owner??s.owner,status??s.status,responsible?JSON.stringify(responsible):s.responsible,total??s.total,deadline!==undefined?deadline:s.deadline,custom?JSON.stringify(custom):s.custom,req.params.id);res.json({success:true});});
app.post('/api/subitems',auth,(req,res)=>{const{id,task_id,name,owner,status,responsible,total,deadline,custom}=req.body;const m=db.prepare('SELECT MAX(sort_order) as m FROM subitems WHERE task_id=?').get(task_id);db.prepare('INSERT INTO subitems (id,task_id,name,owner,status,responsible,total,deadline,custom,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,task_id,name||'Novo subitem',owner||'',status||'Não iniciado',JSON.stringify(responsible||[]),total||0,deadline||null,JSON.stringify(custom||{}),(m?.m||0)+1);res.json({success:true});});

app.post('/api/updates',auth,(req,res)=>{const{id,targetType,targetId,text,mentions,files}=req.body;db.prepare('INSERT INTO updates (id,target_type,target_id,author,text,mentions,files) VALUES(?,?,?,?,?,?,?)').run(id,targetType,targetId,req.user.name,text||'',JSON.stringify(mentions||[]),JSON.stringify(files||[]));res.json({success:true});});

app.get('/api/columns',auth,(req,res)=>res.json(db.prepare('SELECT * FROM columns_config ORDER BY sort_order').all().map(c=>({id:c.id,name:c.name,type:c.type,field:c.field,builtIn:!!c.built_in,isDeadline:!!c.is_deadline,width:c.width}))));
app.post('/api/columns',auth,(req,res)=>{const{id,name,type,field,isDeadline,width}=req.body;const m=db.prepare('SELECT MAX(sort_order) as m FROM columns_config').get().m||0;db.prepare('INSERT INTO columns_config (id,name,type,field,built_in,is_deadline,width,sort_order) VALUES(?,?,?,?,0,?,?,?)').run(id,name,type,field,isDeadline?1:0,width||'80px',m+1);res.json({success:true});});
app.put('/api/columns/:id',auth,(req,res)=>{const{name,isDeadline,width,type}=req.body;if(name)db.prepare('UPDATE columns_config SET name=? WHERE id=?').run(name,req.params.id);if(isDeadline!==undefined)db.prepare('UPDATE columns_config SET is_deadline=? WHERE id=?').run(isDeadline?1:0,req.params.id);if(width)db.prepare('UPDATE columns_config SET width=? WHERE id=?').run(width,req.params.id);if(type)db.prepare('UPDATE columns_config SET type=? WHERE id=?').run(type,req.params.id);res.json({success:true});});
app.delete('/api/columns/:id',auth,adminOnly,(req,res)=>{const c=db.prepare('SELECT built_in FROM columns_config WHERE id=?').get(req.params.id);if(c?.built_in)return res.status(400).json({error:'Não pode excluir nativa'});db.prepare('DELETE FROM columns_config WHERE id=?').run(req.params.id);res.json({success:true});});

app.get('/api/automations',auth,(req,res)=>res.json(db.prepare('SELECT * FROM automations').all().map(a=>({id:a.id,name:a.name,desc:a.description,icon:a.icon,active:!!a.active}))));
app.put('/api/automations/:id',auth,adminOnly,(req,res)=>{const{active}=req.body;db.prepare('UPDATE automations SET active=? WHERE id=?').run(active?1:0,req.params.id);res.json({success:true});});

if(process.env.NODE_ENV==='production'){app.use(express.static(path.join(__dirname,'../client/build')));app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'../client/build/index.html')));}

app.listen(PORT,()=>console.log(`🚀 Server running on port ${PORT}`));
