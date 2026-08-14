import { useState, useMemo, useRef, useEffect } from "react";
import { flushSync } from "react-dom";

// ─── API CLIENT ──────────────────────────────────────────────────────────────
const API_URL = window.location.hostname === "localhost" ? "http://localhost:3001" : "";
let _token = localStorage.getItem("rotina_token");

let _inFlightMutations = 0;
let _syncFailed = 0;
let _isOnline = typeof navigator !== "undefined" ? navigator.onLine : true;
const _syncListeners = new Set();
function _notifySync() { _syncListeners.forEach(fn => { try { fn(); } catch {} }); }
function getSyncStatus() {
  if (!_isOnline) return { state: "offline", inFlight: _inFlightMutations, failed: _syncFailed };
  if (_syncFailed > 0) return { state: "error", inFlight: _inFlightMutations, failed: _syncFailed };
  if (_inFlightMutations > 0) return { state: "saving", inFlight: _inFlightMutations, failed: 0 };
  return { state: "idle", inFlight: 0, failed: 0 };
}
function subscribeSyncStatus(fn) { _syncListeners.add(fn); return () => _syncListeners.delete(fn); }
function clearSyncFailed() { if (_syncFailed > 0) { _syncFailed = 0; _notifySync(); } }

async function apiCall(path, opts = {}) {
  const h = { "Content-Type": "application/json" };
  if (_token) h["Authorization"] = `Bearer ${_token}`;
  const isMutation = opts.method && opts.method.toUpperCase() !== "GET";
  // Strip non-fetch options before forwarding to fetch().
  const { returnError, ...fetchOpts } = opts;
  if (isMutation) { _inFlightMutations++; _notifySync(); }
  try {
    const res = await fetch(`${API_URL}/api${path}`, { ...fetchOpts, headers: { ...h, ...opts.headers } });
    if (res.status === 401) {
      _token = null; localStorage.removeItem("rotina_token");
      if (returnError) return { error: 'Sessão expirada. Faça login novamente.', status: 401 };
      return null;
    }
    let data; try { data = await res.json(); } catch { data = {}; }
    if (!res.ok) {
      if (isMutation && res.status >= 500) { _syncFailed++; }
      const msg = data.error || `Erro ${res.status}`;
      if (returnError) return { error: msg, status: res.status };
      throw new Error(msg);
    }
    if (isMutation && _syncFailed > 0) { _syncFailed = 0; }
    return data;
  } catch (e) {
    if (isMutation && (e.name === "TypeError" || /Failed to fetch|NetworkError/i.test(e.message || ""))) {
      _syncFailed++;
    }
    console.error("API error:", e.message);
    if (returnError) return { error: 'Falha de conexão com o servidor. Verifique sua internet.', status: 0 };
    return null;
  }
  finally { if (isMutation) { _inFlightMutations--; _notifySync(); } }
}
function hasInFlightMutations() { return _inFlightMutations > 0; }
function setToken(t) { _token = t; if (t) localStorage.setItem("rotina_token", t); else localStorage.removeItem("rotina_token"); }
function getToken() { return _token; }

// Assistente de bandeja do Windows (autostart/tray-helper.ps1): restaura e traz
// a janela do quadro para a frente, o que a própria página não pode fazer.
// Roda na máquina de cada usuário, só em loopback.
const TRAY_HELPER_URL = "http://127.0.0.1:35010/attention";

const ALL_PEOPLE = ["Gabriela", "Camila", "Junior", "Ana", "Pedro", "Lucas"];
const STATUSES = ["Não iniciado", "Em andamento", "Parado", "Feito"];
const PRIORITIES = ["Crítica", "Alta", "Média", "Baixa"];
const STATUS_COLORS = { "Não iniciado": { bg: "#c4c4c4", text: "#333" }, "Em andamento": { bg: "#fdab3d", text: "#fff" }, "Parado": { bg: "#e2445c", text: "#fff" }, "Feito": { bg: "#00c875", text: "#fff" } };
const PRIORITY_COLORS = { "Crítica": { bg: "#333", text: "#fff" }, "Alta": { bg: "#401694", text: "#fff" }, "Média": { bg: "#5559df", text: "#fff" }, "Baixa": { bg: "#579bfc", text: "#fff" } };
// Ordem do quadro: crítica no topo, baixa no fim. Sort estável, então tarefas
// de mesma prioridade mantêm a ordem manual em que o usuário as deixou.
const PRIORITY_RANK = PRIORITIES.reduce((acc, p, i) => ({ ...acc, [p]: i }), {});
// Item sem prioridade definida (caso comum em subitens antigos) entra como
// "Média", que é o que a coluna já exibe para eles.
const priorityRank = (p) => (PRIORITY_RANK[p] !== undefined ? PRIORITY_RANK[p] : PRIORITY_RANK["Média"]);
// Critério de desempate dentro da mesma prioridade: ordem de execução. STATUSES
// já está nessa sequência — não iniciado, em andamento, parado, feito — então o
// próprio índice serve de peso. Status vazio conta como "Não iniciado", que é o
// que a coluna exibe nesse caso.
const STATUS_RANK = STATUSES.reduce((acc, s, i) => ({ ...acc, [s]: i }), {});
const statusRank = (s) => (STATUS_RANK[s] !== undefined ? STATUS_RANK[s] : 0);
const sortByPriority = (list) => [...list].sort((a, b) =>
  priorityRank(a.priority) - priorityRank(b.priority) || statusRank(a.status) - statusRank(b.status));
// Essa ordenação só roda ao abrir/trocar de quadro. Enquanto o quadro está
// aberto a ordem fica congelada: trocar o status de uma linha não pode fazer
// ela pular debaixo do cursor (o clique seguinte cairia em outra tarefa) nem
// embaralhar a tela de quem estiver vendo o mesmo quadro.
const sortTaskTree = (tasks) => sortByPriority(tasks).map(t => ({ ...t, subitems: sortByPriority(t.subitems || []) }));
// Colunas de status que um horário automático pode observar. A coluna Status
// nativa é referenciada como `null` — o valor dela mora no campo `status` da
// linha, não no custom — e as criadas pelo usuário, pela própria id.
const statusSourceList = (cols) => (cols || [])
  .filter(c => c.type === "status")
  .map(c => ({ id: c.id, name: c.name, sourceId: (c.builtIn && c.field === "status") ? null : c.id }));
// Reordena `incoming` para acompanhar a ordem que já está na tela (`onScreen`).
// O que não estava na tela — criado por outro usuário desde o último ciclo —
// entra no fim, na ordem em que o servidor mandou.
const keepOrder = (incoming, onScreen) => {
  const rank = new Map(onScreen.map((item, i) => [item.id, i]));
  return incoming
    .map((item, i) => ({ item, r: rank.has(item.id) ? rank.get(item.id) : onScreen.length + i }))
    .sort((a, b) => a.r - b.r)
    .map(x => x.item);
};
const keepTaskTreeOrder = (incoming, onScreen) => {
  const subsById = new Map(onScreen.map(t => [t.id, t.subitems || []]));
  return keepOrder(incoming, onScreen).map(t => ({
    ...t, subitems: keepOrder(t.subitems || [], subsById.get(t.id) || []),
  }));
};

// ─── ANIMAÇÃO DA REORDENAÇÃO (FLIP) ─────────────────────────────────────────
// Sem animação a linha teleporta e o usuário não percebe que o quadro mudou —
// que era metade da queixa original. Aqui medimos onde cada linha está (First),
// aplicamos a mudança de estado de forma síncrona (Last), devolvemos cada uma
// visualmente para o lugar antigo (Invert) e soltamos com transição (Play).
// As linhas se marcam com data-flip-id ("t:<id>" para tarefa, "s:<id>" para
// subitem).
const FLIP_MS = 260;
const flipTops = () => {
  const map = new Map();
  document.querySelectorAll("[data-flip-id]").forEach(el => map.set(el.dataset.flipId, el.getBoundingClientRect().top));
  return map;
};
const flipReorder = (applyChange) => {
  const reduceMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion) { applyChange(); return; }

  const before = flipTops();
  // Síncrono: precisamos do DOM já reposicionado para medir o destino.
  flushSync(applyChange);

  const nodes = Array.from(document.querySelectorAll("[data-flip-id]"));
  const deltas = new Map();
  for (const el of nodes) {
    const prevTop = before.get(el.dataset.flipId);
    if (prevTop !== undefined) deltas.set(el.dataset.flipId, prevTop - el.getBoundingClientRect().top);
  }

  const moved = [];
  for (const el of nodes) {
    const id = el.dataset.flipId;
    if (!deltas.has(id)) continue;
    let dy = deltas.get(id);
    // O subitem mora dentro do bloco da tarefa: se a tarefa inteira andou, esse
    // deslocamento já vem embutido na medida absoluta e seria aplicado duas
    // vezes. Descontamos o movimento do pai.
    if (id.startsWith("s:")) {
      const parentId = el.closest('[data-flip-id^="t:"]')?.dataset.flipId;
      if (parentId && deltas.has(parentId)) dy -= deltas.get(parentId);
    }
    if (!dy) continue;
    moved.push({ el, prevTransition: el.style.transition });
    el.style.transition = "none";
    el.style.transform = `translateY(${dy}px)`;
  }
  if (moved.length === 0) return;

  // Obriga o navegador a comprometer o estado invertido antes de soltar. Sem
  // isso ele coalesce as duas escritas de transform e a transição nunca roda.
  void document.body.offsetHeight;

  for (const { el } of moved) {
    el.style.transition = `transform ${FLIP_MS}ms cubic-bezier(.2,.7,.3,1)`;
    el.style.transform = "";
  }
  // Devolve a transição que o React tinha posto: sobrescrever e deixar assim
  // mataria o efeito de hover das linhas de subitem.
  setTimeout(() => {
    for (const { el, prevTransition } of moved) {
      el.style.transition = prevTransition;
      el.style.transform = "";
    }
  }, FLIP_MS + 60);
};
const PEOPLE_COLORS = { Gabriela: "#ff642e", Camila: "#fdab3d", Junior: "#a25ddc", Ana: "#00c875", Pedro: "#579bfc", Lucas: "#e2445c" };

// Nome de usuário: mesma regra do servidor (3 a 20, letras/números/. _ -).
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,20}$/;

const ROLE_CONFIG = {
  admin: { label: "Administrador", color: "#e2445c", icon: "👑", permissions: { editTasks: true, deleteTasks: true, addColumns: true, deleteColumns: true, manageUsers: true, manageAutomations: true, accessDrive: true, viewAllUpdates: true, exportData: true } },
  collaborator: { label: "Colaborador", color: "#579bfc", icon: "👤", permissions: { editTasks: true, deleteTasks: true, addColumns: true, deleteColumns: false, manageUsers: false, manageAutomations: true, accessDrive: true, viewAllUpdates: false, exportData: false } },
};

const INITIAL_COLUMNS = [
  { id: "col_resp", name: "Responsável", type: "people", field: "responsible", builtIn: true, width: "110px" },
  { id: "col_status", name: "Status", type: "status", field: "status", builtIn: true, width: "120px" },
  { id: "col_priority", name: "Prioridade", type: "priority", field: "priority", builtIn: true, width: "110px" },
  { id: "col_deadline", name: "Prazo", type: "date", field: "deadline", isDeadline: true, builtIn: true, width: "100px" },
  { id: "col_orders", name: "Pedidos", type: "number", field: "totalOrders", builtIn: true, width: "80px" },
  { id: "col_cancel", name: "Canc.", type: "number", field: "totalCancellations", builtIn: true, width: "80px" },
];

const mkSubs = (arr) => arr.map(s => ({ ...s, custom: {}, updates: [], cancellations: s.cancellations || 0 }));

const INITIAL_TASKS = [
  { id: "t1", name: "Verificar pedidos em plataformas", responsible: ["Gabriela", "Camila"], status: "Em andamento", priority: "Alta", deadline: "2026-04-07", totalOrders: 0, totalCancellations: 0, custom: {}, updates: [
    { id: "u1", author: "Gabriela", text: "Pedidos do Mercado Livre verificados. @Camila pode continuar com Shopee?", mentions: ["Camila"], files: [], time: "2026-04-07T09:30:00" },
    { id: "u2", author: "Camila", text: "Vou verificar agora! Segue relatório de ontem.", mentions: [], files: [{ name: "relatorio_06abr.pdf", size: "245 KB" }], time: "2026-04-07T10:15:00" },
  ], subitems: mkSubs([
    { id: "s1a", name: "Mercado Livre Tribo Nerd", owner: "Junior", status: "Em andamento", responsible: ["Camila", "Gabriela"], total: 0 },
    { id: "s1b", name: "Shoppe Oslo Closet", owner: "Junior", status: "Em andamento", responsible: ["Camila", "Gabriela"], total: 0 },
    { id: "s1c", name: "Shoppe Hungria", owner: "Junior", status: "Em andamento", responsible: ["Camila", "Gabriela"], total: 0 },
    { id: "s1d", name: "Shoppe FB Closet", owner: "Junior", status: "Em andamento", responsible: ["Camila", "Gabriela"], total: 0 },
    { id: "s1e", name: "Shoppe Moscow", owner: "Junior", status: "Em andamento", responsible: ["Camila", "Gabriela"], total: 0 },
    { id: "s1f", name: "X2", owner: "Junior", status: "Em andamento", responsible: ["Gabriela", "Camila"], total: 0 },
    { id: "s1g", name: "TikTok", owner: "Junior", status: "Em andamento", responsible: ["Camila", "Gabriela"], total: 0 },
    { id: "s1h", name: "Shein", owner: "Junior", status: "Em andamento", responsible: ["Gabriela", "Camila"], total: 0 },
  ]) },
  { id: "t2", name: "Impressão Etiquetas Pedidos", responsible: ["Camila", "Gabriela"], status: "Em andamento", priority: "Alta", deadline: "2026-04-07", totalOrders: 740, totalCancellations: 0, custom: {}, updates: [
    { id: "u3", author: "Junior", text: "446 etiquetas Shopee impressas. @Gabriela falta confirmar Mercado Livre.", mentions: ["Gabriela"], files: [{ name: "etiquetas_shopee.xlsx", size: "128 KB" }], time: "2026-04-07T08:00:00" },
  ], subitems: mkSubs([
    { id: "s2a", name: "Shopee", owner: "Junior", status: "Em andamento", responsible: ["Camila", "Gabriela"], total: 446 },
    { id: "s2b", name: "Shein", owner: "Junior", status: "Em andamento", responsible: ["Camila", "Gabriela"], total: 0 },
    { id: "s2c", name: "Mercado Livre", owner: "Junior", status: "Em andamento", responsible: ["Camila", "Gabriela"], total: 222 },
    { id: "s2d", name: "TikTok Hungria", owner: "Junior", status: "Em andamento", responsible: ["Camila", "Gabriela"], total: 39 },
    { id: "s2e", name: "TikTok Oslo", owner: "Junior", status: "Em andamento", responsible: ["Camila", "Gabriela"], total: 10 },
    { id: "s2f", name: "Site Diverse", owner: "Junior", status: "Em andamento", responsible: ["Camila", "Gabriela"], total: 22 },
  ]) },
  { id: "t3", name: "Relacionamento com clientes", responsible: ["Gabriela", "Camila"], status: "Em andamento", priority: "Alta", deadline: "2026-04-07", totalOrders: 0, totalCancellations: 0, custom: {}, updates: [], subitems: mkSubs([
    { id: "s3a", name: "Responder Mercado Livre", owner: "Junior", status: "Em andamento", responsible: ["Camila", "Gabriela"], total: 0 },
    { id: "s3b", name: "Responder WhatsApp", owner: "Junior", status: "Em andamento", responsible: ["Camila", "Gabriela"], total: 0 },
    { id: "s3c", name: "Responder Instagram - Moscow Modas", owner: "Junior", status: "Em andamento", responsible: ["Camila", "Gabriela"], total: 0 },
    { id: "s3d", name: "Responder Instagram - Diverse", owner: "Junior", status: "Em andamento", responsible: ["Camila", "Gabriela"], total: 0 },
  ]) },
  { id: "t4", name: "Desconto plataformas", responsible: ["Gabriela", "Camila"], status: "Em andamento", priority: "Média", deadline: "2026-04-07", totalOrders: 0, totalCancellations: 0, custom: {}, updates: [], subitems: mkSubs([
    { id: "s4a", name: "Shopee FB Closet", owner: "Junior", status: "Feito", responsible: ["Camila", "Gabriela"], total: 0 },
    { id: "s4b", name: "Shopee Hungria", owner: "Junior", status: "Feito", responsible: ["Camila", "Gabriela"], total: 0 },
    { id: "s4c", name: "Shopee Oslo", owner: "Junior", status: "Em andamento", responsible: ["Camila", "Gabriela"], total: 0 },
    { id: "s4d", name: "Shopee Moscow", owner: "Junior", status: "Parado", responsible: ["Camila", "Gabriela"], total: 0 },
    { id: "s4e", name: "TikTok Oslo Closet", owner: "Junior", status: "Feito", responsible: ["Camila", "Gabriela"], total: 0 },
  ]) },
  { id: "t5", name: "Desconto Shopee FB Closet", responsible: ["Camila", "Gabriela"], status: "Não iniciado", priority: "Alta", deadline: null, totalOrders: 0, totalCancellations: 0, custom: {}, updates: [], subitems: mkSubs([
    { id: "s5a", name: "Bermuda Promo", owner: "Junior", status: "Feito", responsible: ["Camila", "Gabriela"], total: 0, deadline: "2026-04-06" },
    { id: "s5b", name: "Moletons Novos", owner: "Junior", status: "Não iniciado", responsible: ["Camila", "Gabriela"], total: 0, deadline: "2026-05-27" },
    { id: "s5c", name: "Polos Promos", owner: "Junior", status: "Não iniciado", responsible: ["Camila", "Gabriela"], total: 0, deadline: "2026-06-14" },
  ]) },
  { id: "t6", name: "Desconto Shopee Hungria", responsible: ["Camila", "Gabriela"], status: "Não iniciado", priority: "Alta", deadline: null, totalOrders: 0, totalCancellations: 0, custom: {}, updates: [], subitems: mkSubs([
    { id: "s6a", name: "LA Tricolor", owner: "Junior", status: "Não iniciado", responsible: ["Camila", "Gabriela"], total: 0, deadline: "2026-04-06" },
    { id: "s6b", name: "Bermuda Feminina", owner: "Junior", status: "Não iniciado", responsible: ["Camila", "Gabriela"], total: 0, deadline: "2026-05-04" },
  ]) },
];

const AI_AUTOMATIONS = [
  { id: "ai1", name: "Atribuição inteligente", desc: "IA redistribui tarefas com base na carga", icon: "🤖", active: false },
  { id: "ai2", name: "Priorização automática", desc: "IA ajusta prioridades baseado em prazos", icon: "⚡", active: true },
  { id: "ai3", name: "Alerta de atrasos", desc: "IA notifica quando tarefa está em risco", icon: "🔔", active: true },
  { id: "ai4", name: "Resumo diário", desc: "IA gera resumo do progresso diário", icon: "📊", active: false },
  { id: "ai5", name: "Previsão de conclusão", desc: "IA prevê datas de conclusão", icon: "🔮", active: true },
];

// ─── HELPERS ─────────────────────────────────────────────────────────────────
// Parse "YYYY-MM-DD" as local date (avoids UTC timezone shift)
function parseLocalDate(d) {
  if (!d) return null;
  const [y, m, day] = d.split("-").map(Number);
  return new Date(y, m - 1, day);
}
function formatDate(d) { if (!d) return "—"; const dt = parseLocalDate(d); return dt ? dt.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" }) : "—"; }
function formatTime(d) { if (!d) return ""; const dt = new Date(d); return dt.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" }) + " " + dt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }); }
function daysUntil(d) { if (!d) return null; const now = new Date(); now.setHours(0,0,0,0); const t = parseLocalDate(d); if (!t) return null; t.setHours(0,0,0,0); return Math.ceil((t - now) / 86400000); }
function cycleStatus(c) { return STATUSES[(STATUSES.indexOf(c) + 1) % STATUSES.length]; }
function cyclePriority(c) { return PRIORITIES[(PRIORITIES.indexOf(c) + 1) % PRIORITIES.length]; }
// Map built-in fields: task uses totalOrders/totalCancellations, subitems use total/cancellations
const SUB_FIELD_MAP = { totalOrders: "total", totalCancellations: "cancellations" };
function getVal(item, col) {
  if (col.builtIn) {
    const f = col.field;
    // If item doesn't have the task-level field, try the subitem field
    if (SUB_FIELD_MAP[f] && !(f in item)) return item[SUB_FIELD_MAP[f]];
    return item[f];
  }
  return (item.custom || {})[col.id];
}
function setVal(item, col, val) {
  if (col.builtIn) {
    const f = col.field;
    if (SUB_FIELD_MAP[f] && !(f in item)) return { ...item, [SUB_FIELD_MAP[f]]: val };
    return { ...item, [f]: val };
  }
  return { ...item, custom: { ...(item.custom || {}), [col.id]: val } };
}
function useClickOutside(ref, handler) { useEffect(() => { const fn = (e) => { if (ref.current && !ref.current.contains(e.target)) handler(); }; document.addEventListener("mousedown", fn); return () => document.removeEventListener("mousedown", fn); }, [ref, handler]); }

// Parse @mentions from text
function parseMentions(text, allPeople) {
  const mentions = [];
  const regex = /@(\w+)/g;
  let m;
  while ((m = regex.exec(text)) !== null) {
    const name = allPeople.find(p => p.toLowerCase() === m[1].toLowerCase());
    if (name) mentions.push(name);
  }
  return mentions;
}

// Render text with highlighted mentions
function RenderMentionText({ text }) {
  const parts = text.split(/(@\w+)/g);
  return <>{parts.map((part, i) => part.startsWith("@") ? <span key={i} style={{ color: "#579bfc", fontWeight: 600 }}>{part}</span> : <span key={i}>{part}</span>)}</>;
}

// ─── AVATAR ──────────────────────────────────────────────────────────────────
function Avatar({ name, size = 28 }) {
  const c = PEOPLE_COLORS[name] || "#888";
  return <div style={{ width: size, height: size, borderRadius: "50%", background: c, display: "inline-flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: size * 0.42, fontWeight: 700, flexShrink: 0, border: "2px solid rgba(255,255,255,.85)", marginLeft: -6 }} title={name}>{name ? name[0].toUpperCase() : "?"}</div>;
}
function AvatarGroup({ names = [], size = 28 }) { return <div style={{ display: "flex", paddingLeft: 6 }}>{names.map((n, i) => <Avatar key={i} name={n} size={size} />)}</div>; }

// ─── PEOPLE PICKER ───────────────────────────────────────────────────────────
function PeoplePicker({ selected = [], onChange, allPeople }) {
  const [open, setOpen] = useState(false); const [nn, setNn] = useState("");
  const triggerRef = useRef(null);
  const popupRef = useRef(null);
  // Position popup with `position: fixed` and viewport-relative coords so it
  // escapes any ancestor with overflow:hidden/auto (e.g. the scrollable board area).
  // Flip upward if there's not enough room below the trigger.
  const [popup, setPopup] = useState({ top: 0, left: 0, ready: false });
  useEffect(() => {
    if (!open) return;
    const update = () => {
      if (!triggerRef.current) return;
      const r = triggerRef.current.getBoundingClientRect();
      const POPUP_H_EST = 280;
      const flipUp = (r.bottom + POPUP_H_EST) > window.innerHeight && r.top > POPUP_H_EST;
      setPopup({
        top: flipUp ? r.top - POPUP_H_EST + 4 : r.bottom + 6,
        left: Math.min(r.left, window.innerWidth - 220),
        ready: true,
      });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => { window.removeEventListener("scroll", update, true); window.removeEventListener("resize", update); };
  }, [open]);
  // Close on outside click. Must check both the trigger and the (portal-positioned) popup.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (triggerRef.current && triggerRef.current.contains(e.target)) return;
      if (popupRef.current && popupRef.current.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const toggle = (n) => onChange(selected.includes(n) ? selected.filter(x => x !== n) : [...selected, n]);
  const addC = () => { const t = nn.trim(); if (t && !selected.includes(t)) onChange([...selected, t]); setNn(""); };
  return (
    <div ref={triggerRef} style={{ position: "relative" }}>
      <div onClick={() => setOpen(!open)} style={{ cursor: "pointer" }}>
        {selected.length > 0 ? <AvatarGroup names={selected} size={24} /> : <div style={{ width: 24, height: 24, borderRadius: "50%", border: "2px dashed #555", display: "flex", alignItems: "center", justifyContent: "center", color: "#555", fontSize: 13 }}>+</div>}
      </div>
      {open && popup.ready && (
        <div ref={popupRef} style={{ position: "fixed", top: popup.top, left: popup.left, background: "#2a2d35", borderRadius: 10, padding: 10, minWidth: 200, zIndex: 9999, boxShadow: "0 8px 24px rgba(0,0,0,.5)", border: "1px solid #3a3d45" }}>
          <div style={{ fontSize: 10, color: "#778ca3", fontWeight: 700, marginBottom: 6, textTransform: "uppercase" }}>Responsáveis</div>
          {allPeople.map(p => { const a = selected.includes(p); return (
            <div key={p} onClick={() => toggle(p)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 6px", borderRadius: 6, cursor: "pointer", background: a ? "rgba(108,92,231,.2)" : "transparent", marginBottom: 1 }}>
              <div style={{ width: 16, height: 16, borderRadius: 3, border: a ? "none" : "2px solid #555", background: a ? "#6c5ce7" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#fff", flexShrink: 0 }}>{a ? "✓" : ""}</div>
              <Avatar name={p} size={20} /><span style={{ color: "#e8eaed", fontSize: 12 }}>{p}</span>
            </div>); })}
          <div style={{ borderTop: "1px solid #3a3d45", marginTop: 4, paddingTop: 4, display: "flex", gap: 4 }}>
            <input value={nn} onChange={e => setNn(e.target.value)} onKeyDown={e => e.key === "Enter" && addC()} placeholder="Novo..." style={{ flex: 1, padding: "4px 6px", borderRadius: 5, border: "1px solid #444", background: "#1a1d23", color: "#e8eaed", fontSize: 11, outline: "none" }} />
            <button onClick={addC} style={{ background: "#6c5ce7", color: "#fff", border: "none", borderRadius: 5, padding: "4px 8px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>+</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── EDITABLE CELLS ──────────────────────────────────────────────────────────
function EditNum({ value, onChange }) {
  const [e, setE] = useState(false); const [v, setV] = useState(""); const r = useRef();
  useEffect(() => { if (e && r.current) r.current.focus(); }, [e]);
  const commit = () => { setE(false); const n = parseInt(v, 10); onChange(isNaN(n) ? 0 : n); };
  if (!e) return <div onClick={() => { setV(String(value || "")); setE(true); }} style={{ cursor: "pointer", padding: "2px 4px", borderRadius: 4, color: value ? "#e8eaed" : "#555", fontSize: 13, minWidth: 24 }} onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,.06)"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>{value || "—"}</div>;
  return <input ref={r} type="number" value={v} onChange={e => setV(e.target.value)} onBlur={commit} onKeyDown={e => e.key === "Enter" && commit()} style={{ width: 56, padding: "3px 5px", borderRadius: 4, border: "1px solid #6c5ce7", background: "#1a1d23", color: "#e8eaed", fontSize: 12, outline: "none" }} />;
}
function EditDate({ value, onChange, isDeadline, readOnly }) {
  const [editing, setEditing] = useState(false);
  const [localVal, setLocalVal] = useState(value || "");
  const closingRef = useRef(false);
  const r = useRef();

  useEffect(() => { if (editing) { setLocalVal(value || ""); if (r.current) { try { r.current.showPicker(); } catch(ex) {} r.current.focus(); } } }, [editing]);

  const days = daysUntil(value);
  const color = isDeadline && days !== null ? (days < 0 ? "#e2445c" : days <= 2 ? "#fdab3d" : "#a5b1c2") : "#a5b1c2";

  const handleChange = (ev) => {
    const newVal = ev.target.value || null;
    setLocalVal(newVal || "");
    closingRef.current = true;
    onChange(newVal);
    setEditing(false);
  };

  const handleBlur = () => {
    setTimeout(() => { if (!closingRef.current) setEditing(false); closingRef.current = false; }, 200);
  };

  if (readOnly) return (
    <div title="Prazo automático: sempre a data de hoje" style={{ padding: "2px 4px", borderRadius: 4, color: value ? color : "#555", fontSize: 12, display: "flex", alignItems: "center", gap: 3, whiteSpace: "nowrap", cursor: "default", opacity: 0.95 }}>
      {value ? formatDate(value) : "📅"}
      <span style={{ fontSize: 9, color: "#778ca3" }}>🔒</span>
    </div>
  );

  if (!editing) return (
    <div onClick={() => setEditing(true)} style={{ cursor: "pointer", padding: "2px 4px", borderRadius: 4, color: value ? color : "#555", fontSize: 12, display: "flex", alignItems: "center", gap: 3, whiteSpace: "nowrap" }}
      onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,.06)"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
      {value ? formatDate(value) : "📅"}{isDeadline && days !== null && days < 0 && <span style={{ fontSize: 9 }}>⚠</span>}
    </div>
  );
  return <input ref={r} type="date" value={localVal} onChange={handleChange} onBlur={handleBlur} style={{ width: 120, padding: "3px 5px", borderRadius: 4, border: "1px solid #6c5ce7", background: "#1a1d23", color: "#e8eaed", fontSize: 11, outline: "none" }} />;
}
function EditText({ value, onChange, style: cs = {} }) {
  const [e, setE] = useState(false); const [v, setV] = useState(value || ""); const r = useRef();
  useEffect(() => { if (e && r.current) r.current.focus(); }, [e]);
  const commit = () => { setE(false); if (onChange) onChange(v.trim() || value); };
  if (!e) return <span onDoubleClick={onChange ? () => { setV(value || ""); setE(true); } : undefined} style={{ cursor: onChange ? "default" : "text", ...cs }} title={onChange ? "Duplo-clique para editar" : undefined}>{value || "—"}</span>;
  return <input ref={r} value={v} onChange={e => setV(e.target.value)} onBlur={commit} onKeyDown={e => e.key === "Enter" && commit()} style={{ background: "#1a1d23", color: "#e8eaed", border: "1px solid #6c5ce7", borderRadius: 4, padding: "2px 5px", fontSize: "inherit", fontWeight: "inherit", outline: "none", width: "100%", ...cs }} />;
}
function StatusBadge({ status, onClick, small }) {
  const s = STATUS_COLORS[status] || STATUS_COLORS["Não iniciado"];
  return <div onClick={onClick} style={{ background: s.bg, color: s.text, padding: small ? "4px 0" : "6px 0", borderRadius: 0, fontSize: small ? 11 : 12, fontWeight: 600, cursor: onClick ? "pointer" : "default", textAlign: "center", width: "100%", whiteSpace: "nowrap", userSelect: "none" }}>{status || "Não iniciado"}</div>;
}
function PriorityBadge({ priority, onClick }) {
  const p = PRIORITY_COLORS[priority] || PRIORITY_COLORS["Média"];
  return <div onClick={onClick} style={{ background: p.bg, color: p.text, padding: "6px 0", borderRadius: 0, fontSize: 12, fontWeight: 600, textAlign: "center", width: "100%", cursor: onClick ? "pointer" : "default", userSelect: "none" }}>{priority}</div>;
}
// Horário no formato 24h ("HH:MM"), guardado como texto — mesmo formato do
// <input type="time">, o que mantém a ordenação alfabética igual à cronológica.
function EditTime({ value, onChange, small }) {
  const [editing, setEditing] = useState(false);
  const r = useRef();
  const closingRef = useRef(false);

  useEffect(() => { if (editing && r.current) { try { r.current.showPicker(); } catch (ex) {} r.current.focus(); } }, [editing]);

  const commit = (v) => { closingRef.current = true; onChange(v || null); setEditing(false); };

  if (!editing) return (
    <div onClick={() => setEditing(true)} title="Clique para definir o horário"
      style={{ cursor: "pointer", padding: "2px 5px", borderRadius: 4, color: value ? "#a5b1c2" : "#555", fontSize: small ? 12 : 12.5, display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}
      onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,.06)"}
      onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
      {value ? <><span style={{ fontSize: 10 }}>🕐</span>{value}</> : "🕐"}
    </div>
  );

  return (
    <input ref={r} type="time" value={value || ""}
      onChange={e => commit(e.target.value)}
      onBlur={() => setTimeout(() => { if (!closingRef.current) setEditing(false); closingRef.current = false; }, 200)}
      onKeyDown={e => { if (e.key === "Enter") commit(e.target.value); if (e.key === "Escape") setEditing(false); }}
      style={{ width: "100%", padding: "3px 4px", borderRadius: 4, border: "1px solid #6c5ce7", background: "#1a1d23", color: "#e8eaed", fontSize: 12, outline: "none", colorScheme: "dark" }} />
  );
}

function CellRenderer({ col, item, onChange, allPeople, small, subitems, subColumns, taskColumns }) {
  const val = getVal(item, col);
  const update = (v) => onChange(setVal(item, col, v));

  if (col.type === "number" && col.computed === "row_sum_numeric_siblings" && subColumns) {
    // 1) Sum the native "total" field (Pedidos) — always include unless cancellations
    const nativeTotal = Number(item.total) || 0;

    // 2) Sum custom numeric subcolumns (exclude self, cancel columns, and other computed)
    const customSiblings = subColumns.filter(sc =>
      sc.id !== col.id &&
      sc.type === "number" &&
      sc.computed !== "row_sum_numeric_siblings" &&
      sc.parentColumnId !== "col_cancel" &&
      sc.field !== "totalCancellations" &&
      !/cancel/i.test(sc.field) &&
      !/cancelamento/i.test(sc.name)
    );
    const customSum = customSiblings.reduce((acc, sc) => {
      const raw = (item.custom || {})[sc.id] ?? (item.custom || {})[sc.field];
      const n = Number(raw);
      return acc + (Number.isFinite(n) ? n : 0);
    }, 0);

    const rowSum = nativeTotal + customSum;
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: rowSum > 0 ? "#e8eaed" : "#555" }}>{rowSum || "—"}</span>
        <span style={{ fontSize: 9, color: "#556" }} title="Soma das subcolunas numéricas desta linha">Σ</span>
      </div>
    );
  }

  if (col.type === "number" && subitems && subitems.length > 0) {
    let sum = null;
    if (col.builtIn && col.field === "totalOrders" && subColumns && subColumns.length > 0) {
      // Sum each subitem's native total + custom numeric subcolumns (excluding cancel)
      const computedCol = subColumns.find(sc => sc.computed === "row_sum_numeric_siblings" && sc.type === "number");
      const customSiblings = subColumns.filter(sc =>
        sc.type === "number" &&
        sc.computed !== "row_sum_numeric_siblings" &&
        sc.parentColumnId !== "col_cancel" &&
        !/cancel/i.test(sc.field) &&
        !/cancelamento/i.test(sc.name)
      );
      if (computedCol || customSiblings.length > 0) {
        sum = subitems.reduce((a, s) => {
          const nativeTotal = Number(s.total) || 0;
          const customTotal = customSiblings.reduce((acc, sc) => {
            const raw = (s.custom || {})[sc.id] ?? (s.custom || {})[sc.field];
            const n = Number(raw);
            return acc + (Number.isFinite(n) ? n : 0);
          }, 0);
          return a + nativeTotal + customTotal;
        }, 0);
      } else {
        sum = subitems.reduce((a, s) => a + (Number(s.total) || 0), 0);
      }
    } else if (col.builtIn) {
      const sumField = col.field === "totalCancellations" ? "cancellations" : null;
      if (sumField) sum = subitems.reduce((a, s) => a + (Number(s[sumField]) || 0), 0);
    } else if (subColumns && subColumns.length > 0) {
      const children = subColumns.filter(sc => sc.parentColumnId === col.id && sc.type === "number");
      if (children.length > 0) {
        sum = subitems.reduce((a, s) => a + children.reduce((b, cc) => b + (Number((s.custom || {})[cc.field]) || 0), 0), 0);
      }
    }
    if (sum !== null) {
      return (
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: sum > 0 ? "#e8eaed" : "#555" }}>{sum || "—"}</span>
          <span style={{ fontSize: 9, color: "#556" }} title="Soma dos subitens">Σ</span>
        </div>
      );
    }
  }

  switch (col.type) {
    case "people": return <PeoplePicker selected={val || []} onChange={v => update(v)} allPeople={allPeople} />;
    case "status": return <StatusBadge status={val || "Não iniciado"} small={small} onClick={() => update(cycleStatus(val || "Não iniciado"))} />;
    case "priority": return <PriorityBadge priority={val || "Média"} onClick={() => update(cyclePriority(val || "Média"))} />;
    case "date": {
      // Parent task's built-in deadline is auto-managed (= today, refreshed daily). Subitems remain editable.
      const isAutoParentDeadline = col.builtIn && col.field === "deadline" && !small;
      return <EditDate value={val || null} onChange={v => update(v)} isDeadline={col.isDeadline} readOnly={isAutoParentDeadline} />;
    }
    case "time": return <EditTime value={val || ""} onChange={v => update(v)} small={small} />;
    case "number": return <EditNum value={val || 0} onChange={v => update(v)} />;
    case "text": return <EditText value={val || ""} onChange={v => update(v)} style={{ color: "#c8ccd4", fontSize: small ? 12 : 13 }} />;
    default: return <span style={{ color: "#555" }}>—</span>;
  }
}

// ─── DRIVE MINI FILE PICKER (for attaching in chat) ─────────────────────────
function DriveMiniPicker({ onSelect, onClose }) {
  const [search, setSearch] = useState("");
  const [folder, setFolder] = useState("Todos");
  const filtered = useMemo(() => {
    let f = INITIAL_DRIVE_FILES;
    if (folder !== "Todos") f = f.filter(x => x.folder === folder);
    if (search) { const q = search.toLowerCase(); f = f.filter(x => x.name.toLowerCase().includes(q)); }
    return f;
  }, [search, folder]);

  return (
    <div style={{ position: "absolute", bottom: "100%", left: 0, marginBottom: 6, background: "#2a2d35", borderRadius: 12, width: 380, maxHeight: 400, zIndex: 60, boxShadow: "0 -8px 30px rgba(0,0,0,.5)", border: "1px solid #3a3d45", overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "12px 14px", borderBottom: "1px solid #333", display: "flex", alignItems: "center", gap: 8 }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="#4285f4"><path d="M7.71 3.5L1.15 15l2.76 4.5h6.06L7.71 3.5zM8.8 3.5h6.06l6.56 12h-6.06L8.8 3.5zM16.62 16h-6.06l-2.76 4.5h6.06L16.62 16z" opacity=".9"/></svg>
        <span style={{ fontWeight: 700, fontSize: 13, color: "#e8eaed" }}>Google Drive</span>
        <div style={{ flex: 1 }} />
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#778ca3", fontSize: 16, cursor: "pointer" }}>×</button>
      </div>
      <div style={{ padding: "8px 14px", display: "flex", gap: 6 }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Pesquisar arquivos..." style={{ flex: 1, padding: "6px 8px", borderRadius: 6, border: "1px solid #444", background: "#13151a", color: "#e8eaed", fontSize: 11, outline: "none" }} />
        <select value={folder} onChange={e => setFolder(e.target.value)} style={{ padding: "6px 6px", borderRadius: 6, border: "1px solid #444", background: "#13151a", color: "#e8eaed", fontSize: 11 }}>
          {DRIVE_FOLDERS.map(f => <option key={f} value={f}>{f}</option>)}
        </select>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: "4px 8px 8px" }}>
        {filtered.length === 0 && <div style={{ textAlign: "center", padding: 16, color: "#556", fontSize: 12 }}>Nenhum arquivo encontrado</div>}
        {filtered.map(f => {
          const ic = FILE_ICONS[f.type] || { color: "#778ca3", label: "?" };
          return (
            <div key={f.id} onClick={() => { onSelect(f); onClose(); }}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 8px", borderRadius: 6, cursor: "pointer", marginBottom: 2, transition: "background .1s" }}
              onMouseEnter={e => e.currentTarget.style.background = "rgba(87,155,252,.08)"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <div style={{ width: 28, height: 28, borderRadius: 5, background: ic.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700, color: "#fff", flexShrink: 0 }}>{ic.label}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#e8eaed", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</div>
                <div style={{ fontSize: 10, color: "#556" }}>{f.folder} · {f.size}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── UPDATES / REPORT PANEL ──────────────────────────────────────────────────
function UpdatesPanel({ itemName, updates = [], onAddUpdate, onEditUpdate, onDeleteFile, onDeleteUpdate, onClose, allPeople, currentUserName }) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState([]);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState("");
  const [editFiles, setEditFiles] = useState([]);
  const [lightbox, setLightbox] = useState(null); // { url, name } | null
  const inputRef = useRef(null);
  const editRef = useRef(null);
  const listRef = useRef(null);
  const fileInputRef = useRef(null);
  const editFileInputRef = useRef(null);

  useEffect(() => { if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight; }, [updates]);
  useEffect(() => { if (editingId && editRef.current) editRef.current.focus(); }, [editingId]);

  const handleTextChange = (e) => {
    const v = e.target.value;
    setText(v);
    const lastAt = v.lastIndexOf("@");
    if (lastAt >= 0 && (lastAt === 0 || v[lastAt - 1] === " ")) {
      const after = v.slice(lastAt + 1);
      if (!after.includes(" ")) { setShowMentions(true); setMentionFilter(after.toLowerCase()); return; }
    }
    setShowMentions(false);
  };

  const insertMention = (name) => {
    const lastAt = text.lastIndexOf("@");
    const newText = text.slice(0, lastAt) + "@" + name + " ";
    setText(newText);
    setShowMentions(false);
    inputRef.current?.focus();
  };

  const formatFileSize = (bytes) => {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  };

  const processFiles = async (fileList, setter) => {
    const arr = Array.from(fileList);
    // Placeholder otimista enquanto sobe
    const placeholders = arr.map(file => ({
      _key: "ph_" + Math.random().toString(36).slice(2),
      name: file.name,
      size: formatFileSize(file.size),
      uploading: true,
    }));
    setter(prev => [...prev, ...placeholders]);
    const formData = new FormData();
    arr.forEach(f => formData.append("files", f));
    try {
      const token = getToken();
      const res = await fetch(`${API_URL}/api/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const uploaded = (data.files || []).map(f => ({
        id: f.id, name: f.name, mime: f.mime, size: formatFileSize(f.size),
      }));
      setter(prev => {
        const remaining = prev.filter(p => !placeholders.find(ph => ph._key === p._key));
        return [...remaining, ...uploaded];
      });
    } catch (e) {
      setter(prev => prev.filter(p => !placeholders.find(ph => ph._key === p._key)));
      alert("Falha no upload: " + (e.message || "erro desconhecido"));
    }
  };

  const addDriveFile = (driveFile, setter) => {
    setter(prev => [...prev, { name: driveFile.name, size: driveFile.size, driveId: driveFile.id }]);
  };

  // Attach menu state
  const [attachMenu, setAttachMenu] = useState(null); // null | "new" | "edit"
  const [showDrivePicker, setShowDrivePicker] = useState(null); // null | "new" | "edit"
  const attachRef = useRef(null);
  const attachEditRef = useRef(null);
  useClickOutside(attachRef, () => { if (attachMenu === "new") setAttachMenu(null); });
  useClickOutside(attachEditRef, () => { if (attachMenu === "edit") setAttachMenu(null); });

  const handleSend = () => {
    if (!text.trim() && files.length === 0) return;
    if (files.some(f => f.uploading)) { alert("Aguarde o upload terminar."); return; }
    const mentions = parseMentions(text, allPeople);
    onAddUpdate({ id: "u" + Date.now(), author: "Você", text: text.trim(), mentions, files: [...files], time: new Date().toISOString() });
    setText(""); setFiles([]);
  };

  const startEdit = (u) => { setEditingId(u.id); setEditText(u.text); setEditFiles([...(u.files || [])]); };
  const cancelEdit = () => { setEditingId(null); setEditText(""); setEditFiles([]); };
  const saveEdit = (u) => {
    if (!editText.trim() && editFiles.length === 0) { cancelEdit(); return; }
    if (editFiles.some(f => f.uploading)) { alert("Aguarde o upload terminar."); return; }
    if (onEditUpdate) onEditUpdate(u.id, editText.trim(), editFiles);
    setEditingId(null); setEditText(""); setEditFiles([]);
  };

  const filteredPeople = allPeople.filter(p => p.toLowerCase().includes(mentionFilter));

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", display: "flex", justifyContent: "flex-end", zIndex: 100, backdropFilter: "blur(3px)" }} onClick={onClose}>
      <div style={{ width: 480, maxWidth: "95vw", background: "#1a1d23", height: "100%", display: "flex", flexDirection: "column", animation: "slideIn .2s ease", borderLeft: "1px solid #2a2d35" }} onClick={e => e.stopPropagation()}>
        {/* Hidden file inputs */}
        <input ref={fileInputRef} type="file" multiple style={{ display: "none" }} onChange={e => { if (e.target.files.length) processFiles(e.target.files, setFiles); e.target.value = ""; }} />
        <input ref={editFileInputRef} type="file" multiple style={{ display: "none" }} onChange={e => { if (e.target.files.length) processFiles(e.target.files, setEditFiles); e.target.value = ""; }} />
        {/* Header */}
        <div style={{ padding: "16px 20px", borderBottom: "1px solid #2a2d35", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: 8, background: "linear-gradient(135deg, #579bfc, #6c5ce7)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>💬</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: "#e8eaed" }}>Relatórios</div>
            <div style={{ fontSize: 12, color: "#778ca3", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{itemName}</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#778ca3", fontSize: 22, cursor: "pointer", padding: "4px" }}>×</button>
        </div>

        {/* Messages */}
        <div ref={listRef} style={{ flex: 1, overflow: "auto", padding: "16px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
          {updates.length === 0 && (
            <div style={{ textAlign: "center", padding: "40px 20px", color: "#556" }}>
              <div style={{ fontSize: 40, marginBottom: 10 }}>💬</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "#778ca3" }}>Nenhum relatório ainda</div>
              <div style={{ fontSize: 12, color: "#556", marginTop: 4 }}>Escreva uma mensagem, mencione pessoas com @ e anexe arquivos</div>
            </div>
          )}
          {updates.map(u => {
            const isOwn = currentUserName && (u.author === currentUserName || u.author === "Você");
            return (
            <div key={u.id} style={{ background: "#23262e", borderRadius: 10, padding: 14, borderLeft: `3px solid ${PEOPLE_COLORS[u.author] || "#6c5ce7"}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <Avatar name={u.author} size={28} />
                <div style={{ flex: 1 }}>
                  <span style={{ fontWeight: 600, fontSize: 13, color: "#e8eaed", marginLeft: 6 }}>{u.author}</span>
                  <span style={{ fontSize: 11, color: "#556", marginLeft: 8 }}>{formatTime(u.time)}</span>
                </div>
                {/* Edit button - only own messages */}
                {isOwn && editingId !== u.id && (
                  <div onClick={() => startEdit(u)} style={{ cursor: "pointer", padding: "3px 6px", borderRadius: 5, display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#556", transition: "all .15s" }}
                    onMouseEnter={e => { e.currentTarget.style.background = "rgba(87,155,252,.1)"; e.currentTarget.style.color = "#579bfc"; }}
                    onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "#556"; }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    Editar
                  </div>
                )}
                {/* Delete button - only own messages */}
                {isOwn && editingId !== u.id && onDeleteUpdate && (
                  <div onClick={() => { if (window.confirm('Excluir este relatório? Esta ação não pode ser desfeita.')) onDeleteUpdate(u.id); }}
                    style={{ cursor: "pointer", padding: "3px 6px", borderRadius: 5, display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#556", transition: "all .15s" }}
                    onMouseEnter={e => { e.currentTarget.style.background = "rgba(226,68,92,.1)"; e.currentTarget.style.color = "#e2445c"; }}
                    onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "#556"; }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                    Excluir
                  </div>
                )}
              </div>

              {/* Message text or edit mode */}
              {isOwn && editingId === u.id ? (
                <div style={{ marginLeft: 2 }}>
                  <textarea ref={editRef} value={editText} onChange={e => setEditText(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEdit(u); } if (e.key === "Escape") cancelEdit(); }}
                    style={{ width: "100%", minHeight: 50, padding: "8px 10px", borderRadius: 8, border: "1px solid #6c5ce7", background: "#13151a", color: "#e8eaed", fontSize: 13, outline: "none", resize: "none", lineHeight: 1.5, boxSizing: "border-box" }} />
                  
                  {/* Edit files */}
                  {editFiles.length > 0 && (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                      {editFiles.map((f, fi) => (
                        <div key={fi} style={{ display: "flex", alignItems: "center", gap: 4, background: "#2a2d35", borderRadius: 6, padding: "4px 8px", fontSize: 11, color: f.uploading ? "#fdab3d" : "#a5b1c2", opacity: f.uploading ? 0.7 : 1 }}>
                          {f.uploading ? "⏳" : "📎"} {f.name}{f.uploading ? " (enviando...)" : ""}
                          <span onClick={() => setEditFiles(prev => prev.filter((_, j) => j !== fi))} style={{ cursor: "pointer", color: "#e2445c", fontWeight: 700, marginLeft: 2 }}>×</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div style={{ display: "flex", gap: 6, marginTop: 6, justifyContent: "space-between", alignItems: "center" }}>
                    <div ref={attachEditRef} style={{ position: "relative" }}>
                      <button onClick={() => setAttachMenu(attachMenu === "edit" ? null : "edit")} style={{ background: "#2a2d35", color: "#a5b1c2", border: "1px solid #3a3d45", borderRadius: 6, padding: "4px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>📎 Anexar</button>
                      {attachMenu === "edit" && (
                        <div style={{ position: "absolute", bottom: "100%", left: 0, marginBottom: 6, background: "#2a2d35", borderRadius: 10, padding: 6, minWidth: 200, zIndex: 55, boxShadow: "0 -6px 20px rgba(0,0,0,.5)", border: "1px solid #3a3d45" }}>
                          <div onClick={() => { editFileInputRef.current?.click(); setAttachMenu(null); }}
                            style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: 7, cursor: "pointer", fontSize: 12, color: "#e8eaed" }}
                            onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,.05)"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                            <span style={{ fontSize: 14 }}>💻</span> Meu computador
                          </div>
                          <div onClick={() => { setAttachMenu(null); setShowDrivePicker("edit"); }}
                            style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: 7, cursor: "pointer", fontSize: 12, color: "#e8eaed" }}
                            onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,.05)"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="#4285f4"><path d="M7.71 3.5L1.15 15l2.76 4.5h6.06L7.71 3.5zM8.8 3.5h6.06l6.56 12h-6.06L8.8 3.5zM16.62 16h-6.06l-2.76 4.5h6.06L16.62 16z" opacity=".9"/></svg>
                            Google Drive
                          </div>
                        </div>
                      )}
                      {showDrivePicker === "edit" && <DriveMiniPicker onSelect={(f) => addDriveFile(f, setEditFiles)} onClose={() => setShowDrivePicker(null)} />}
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button onClick={cancelEdit} style={{ padding: "4px 12px", borderRadius: 6, border: "1px solid #444", background: "transparent", color: "#a5b1c2", fontSize: 11, cursor: "pointer" }}>Cancelar</button>
                      <button onClick={() => saveEdit(u)} style={{ padding: "4px 12px", borderRadius: 6, border: "none", background: "#6c5ce7", color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Salvar</button>
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 13, color: "#c8ccd4", lineHeight: 1.6, marginLeft: 2 }}>
                  <RenderMentionText text={u.text} />
                </div>
              )}

              {u.files && u.files.length > 0 && (
                <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                  {u.files.map((f, fi) => {
                    const ext = (f.name || "").split(".").pop().toLowerCase();
                    const isImage = (f.mime && f.mime.startsWith("image/")) || ["jpg","jpeg","png","gif","webp","bmp","svg"].includes(ext);
                    const hasFile = !!f.id;
                    const fileUrl = hasFile ? `${API_URL}/api/files/${f.id}?token=${encodeURIComponent(getToken() || "")}` : null;
                    const downloadUrl = hasFile ? `${fileUrl}&download=1` : null;
                    const iconBg = ext === "pdf" ? "#e2445c" : ext === "xlsx" || ext === "xls" || ext === "csv" ? "#00c875" : isImage ? "#fdab3d" : ext === "doc" || ext === "docx" ? "#579bfc" : "#778ca3";
                    return (
                      <div key={fi} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", background: "#1a1d23", borderRadius: 8, border: "1px solid #333", opacity: hasFile ? 1 : 0.55 }}>
                        {hasFile && isImage ? (
                          <img src={fileUrl} alt={f.name} loading="lazy"
                            onClick={() => setLightbox({ url: fileUrl, name: f.name })}
                            style={{ width: 56, height: 56, borderRadius: 6, objectFit: "cover", cursor: "zoom-in", border: "1px solid #2a2d35", background: "#0f1115" }} />
                        ) : (
                          <div style={{ width: 56, height: 56, borderRadius: 6, background: iconBg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: "#fff", flexShrink: 0 }}>
                            {(ext || "?").toUpperCase().slice(0, 4)}
                          </div>
                        )}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: "#e8eaed", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</div>
                          <div style={{ fontSize: 10, color: "#778ca3", marginBottom: 4 }}>{f.size}{f.uploading ? " • enviando..." : ""}</div>
                          {hasFile ? (
                            <div style={{ display: "flex", gap: 6 }}>
                              <a href={fileUrl} target="_blank" rel="noopener noreferrer"
                                style={{ fontSize: 11, color: "#579bfc", textDecoration: "none", padding: "2px 8px", borderRadius: 4, border: "1px solid #2a4d7a", background: "rgba(87,155,252,.08)" }}>👁 Abrir</a>
                              <a href={downloadUrl}
                                style={{ fontSize: 11, color: "#a5b1c2", textDecoration: "none", padding: "2px 8px", borderRadius: 4, border: "1px solid #3a3d45", background: "transparent" }}>⬇ Baixar</a>
                            </div>
                          ) : (
                            <div style={{ fontSize: 10, color: "#e2445c", fontStyle: "italic" }}>arquivo indisponível (anexo antigo)</div>
                          )}
                        </div>
                        {isOwn && <span onClick={() => { if (onDeleteFile) onDeleteFile(u.id, fi); }}
                          style={{ fontSize: 13, cursor: "pointer", color: "#556", padding: "2px 6px", borderRadius: 4, transition: "all .15s" }} title="Remover anexo"
                          onMouseEnter={e => { e.currentTarget.style.color = "#e2445c"; e.currentTarget.style.background = "rgba(226,68,92,.1)"; }}
                          onMouseLeave={e => { e.currentTarget.style.color = "#556"; e.currentTarget.style.background = "transparent"; }}>✕</span>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            );
          })}
        </div>

        {/* Input area */}
        <div style={{ padding: "12px 20px", borderTop: "1px solid #2a2d35", background: "#1e2028" }}>
          {files.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
              {files.map((f, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 4, background: "#2a2d35", borderRadius: 6, padding: "4px 8px", fontSize: 11, color: f.uploading ? "#fdab3d" : "#a5b1c2", opacity: f.uploading ? 0.7 : 1 }}>
                  {f.uploading ? "⏳" : "📎"} {f.name}{f.uploading ? " (enviando...)" : ""} <span onClick={() => setFiles(files.filter((_, j) => j !== i))} style={{ cursor: "pointer", color: "#e2445c", fontWeight: 700, marginLeft: 2 }}>×</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ position: "relative" }}>
            <textarea ref={inputRef} value={text} onChange={handleTextChange} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
              placeholder="Escreva um relatório... Use @nome para mencionar"
              style={{ width: "100%", minHeight: 60, padding: "10px 12px", borderRadius: 10, border: "1px solid #333", background: "#13151a", color: "#e8eaed", fontSize: 13, outline: "none", resize: "none", lineHeight: 1.5, boxSizing: "border-box" }} />
            {showMentions && filteredPeople.length > 0 && (
              <div style={{ position: "absolute", bottom: "100%", left: 0, marginBottom: 4, background: "#2a2d35", borderRadius: 8, padding: 6, minWidth: 180, zIndex: 55, boxShadow: "0 -4px 16px rgba(0,0,0,.4)", border: "1px solid #3a3d45" }}>
                {filteredPeople.map(p => (
                  <div key={p} onClick={() => insertMention(p)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", borderRadius: 6, cursor: "pointer", fontSize: 13, color: "#e8eaed" }}
                    onMouseEnter={e => e.currentTarget.style.background = "rgba(108,92,231,.2)"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <Avatar name={p} size={22} /><span style={{ marginLeft: 4 }}>{p}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8, justifyContent: "space-between" }}>
            <div ref={attachRef} style={{ position: "relative" }}>
              <button onClick={() => setAttachMenu(attachMenu === "new" ? null : "new")} style={{ background: "#2a2d35", color: "#a5b1c2", border: "1px solid #3a3d45", borderRadius: 8, padding: "7px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 5 }}>📎 Anexar arquivo</button>
              {attachMenu === "new" && (
                <div style={{ position: "absolute", bottom: "100%", left: 0, marginBottom: 6, background: "#2a2d35", borderRadius: 10, padding: 6, minWidth: 220, zIndex: 55, boxShadow: "0 -6px 20px rgba(0,0,0,.5)", border: "1px solid #3a3d45" }}>
                  <div onClick={() => { fileInputRef.current?.click(); setAttachMenu(null); }}
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 7, cursor: "pointer", fontSize: 13, color: "#e8eaed" }}
                    onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,.05)"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <span style={{ fontSize: 16 }}>💻</span> Meu computador
                  </div>
                  <div onClick={() => { setAttachMenu(null); setShowDrivePicker("new"); }}
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 7, cursor: "pointer", fontSize: 13, color: "#e8eaed" }}
                    onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,.05)"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="#4285f4"><path d="M7.71 3.5L1.15 15l2.76 4.5h6.06L7.71 3.5zM8.8 3.5h6.06l6.56 12h-6.06L8.8 3.5zM16.62 16h-6.06l-2.76 4.5h6.06L16.62 16z" opacity=".9"/></svg>
                    Google Drive
                  </div>
                </div>
              )}
              {showDrivePicker === "new" && <DriveMiniPicker onSelect={(f) => addDriveFile(f, setFiles)} onClose={() => setShowDrivePicker(null)} />}
            </div>
            <button onClick={handleSend} style={{ background: "#6c5ce7", color: "#fff", border: "none", borderRadius: 8, padding: "7px 18px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Enviar</button>
          </div>
        </div>
      </div>
      {lightbox && (
        <div onClick={() => setLightbox(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", cursor: "zoom-out", padding: 24 }}>
          <img src={lightbox.url} alt={lightbox.name}
            onClick={e => e.stopPropagation()}
            style={{ maxWidth: "95%", maxHeight: "90%", objectFit: "contain", borderRadius: 8, boxShadow: "0 8px 40px rgba(0,0,0,.6)" }} />
          <div style={{ position: "absolute", top: 16, right: 20, color: "#fff", fontSize: 13, fontWeight: 600, background: "rgba(0,0,0,.5)", padding: "6px 12px", borderRadius: 6 }}>
            {lightbox.name} <span style={{ marginLeft: 12, cursor: "pointer", color: "#a5b1c2" }} onClick={() => setLightbox(null)}>✕</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── NOTIFICATION PANEL ──────────────────────────────────────────────────────
function NotificationPanel({ tasks, currentUser, onClose, onOpenUpdates, soundEnabled, onToggleSound, popupEnabled, onTogglePopup, popupSupported, popupBlocked }) {
  const notifications = useMemo(() => {
    const notifs = [];
    tasks.forEach(task => {
      // Updates where current user is responsible
      if ((task.responsible || []).includes(currentUser)) {
        task.updates.forEach(u => {
          if (u.author !== currentUser) notifs.push({ type: "update", task: task.name, taskId: task.id, ...u });
        });
      }
      // Mentions
      task.updates.forEach(u => {
        if (u.mentions.includes(currentUser) && u.author !== currentUser) {
          notifs.push({ type: "mention", task: task.name, taskId: task.id, ...u });
        }
      });
      // Sub updates
      task.subitems.forEach(sub => {
        if ((sub.responsible || []).includes(currentUser)) {
          (sub.updates || []).forEach(u => {
            if (u.author !== currentUser) notifs.push({ type: "update", task: sub.name, taskId: task.id, subId: sub.id, ...u });
          });
        }
        (sub.updates || []).forEach(u => {
          if (u.mentions.includes(currentUser) && u.author !== currentUser) {
            notifs.push({ type: "mention", task: sub.name, taskId: task.id, subId: sub.id, ...u });
          }
        });
      });
    });
    // Deduplicate by id
    const seen = new Set();
    return notifs.filter(n => { if (seen.has(n.id + n.type)) return false; seen.add(n.id + n.type); return true; })
      .sort((a, b) => new Date(b.time) - new Date(a.time));
  }, [tasks, currentUser]);

  return (
    <div style={{ position: "absolute", top: "100%", right: 0, marginTop: 8, width: 380, maxHeight: 480, background: "#2a2d35", borderRadius: 12, boxShadow: "0 12px 40px rgba(0,0,0,.6)", border: "1px solid #3a3d45", zIndex: 60, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "14px 18px", borderBottom: "1px solid #3a3d45", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 15, color: "#e8eaed" }}>Notificações</span>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {onToggleSound && (
            <button onClick={onToggleSound}
              title={soundEnabled ? "Som ativado — clique para silenciar" : "Som desativado — clique para ativar"}
              style={{ background: "transparent", border: "1px solid #3a3d45", borderRadius: 6, padding: "3px 8px", fontSize: 13, cursor: "pointer", color: soundEnabled ? "#fdab3d" : "#556", lineHeight: 1 }}>
              {soundEnabled ? "🔔" : "🔕"}
            </button>
          )}
          {onTogglePopup && (
            <button onClick={popupSupported ? onTogglePopup : undefined}
              title={!popupSupported ? "Popup indisponível: o navegador só permite notificações em localhost ou https"
                : popupBlocked ? "Notificações bloqueadas no navegador — clique para ver como liberar"
                : popupEnabled ? "Popup do sistema ativado — clique para desativar" : "Popup do sistema desativado — clique para ativar"}
              style={{ background: "transparent", border: "1px solid #3a3d45", borderRadius: 6, padding: "3px 8px", fontSize: 13, cursor: popupSupported ? "pointer" : "not-allowed", color: popupEnabled ? "#fdab3d" : "#556", lineHeight: 1, opacity: popupSupported ? 1 : 0.4 }}>
              {popupEnabled ? "🖥️" : "🚫"}
            </button>
          )}
          <span style={{ fontSize: 12, color: "#778ca3" }}>{notifications.length} itens</span>
        </div>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: 8 }}>
        {notifications.length === 0 && (
          <div style={{ textAlign: "center", padding: "30px 16px", color: "#556" }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>🔔</div>
            <div style={{ fontSize: 13, color: "#778ca3" }}>Nenhuma notificação</div>
          </div>
        )}
        {notifications.map((n, i) => (
          <div key={i} onClick={() => { onOpenUpdates(n.taskId, n.subId); onClose(); }}
            style={{ padding: "10px 12px", borderRadius: 8, cursor: "pointer", marginBottom: 4, transition: "background .1s", borderLeft: `3px solid ${n.type === "mention" ? "#579bfc" : "#fdab3d"}` }}
            onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,.04)"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 14 }}>{n.type === "mention" ? "💬" : "📋"}</span>
              <Avatar name={n.author} size={22} />
              <span style={{ fontWeight: 600, fontSize: 12, color: "#e8eaed", marginLeft: 2 }}>{n.author}</span>
              <span style={{ fontSize: 10, color: "#556", marginLeft: "auto" }}>{formatTime(n.time)}</span>
            </div>
            <div style={{ fontSize: 12, color: "#a5b1c2", marginLeft: 24, marginBottom: 2 }}>
              {n.type === "mention" ? <span style={{ color: "#579bfc", fontWeight: 600 }}>Mencionou você</span> : <span>Novo relatório</span>}
              <span style={{ color: "#556" }}> em </span>
              <span style={{ color: "#e8eaed", fontWeight: 500 }}>{n.task}</span>
            </div>
            <div style={{ fontSize: 11, color: "#667", marginLeft: 24, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {n.text.slice(0, 80)}{n.text.length > 80 ? "..." : ""}
            </div>
            {n.files && n.files.length > 0 && <div style={{ fontSize: 10, color: "#579bfc", marginLeft: 24, marginTop: 3 }}>📎 {n.files.length} anexo(s)</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── CHAT BUBBLE BUTTON ──────────────────────────────────────────────────────
function ChatBubble({ count, onClick }) {
  return (
    <div onClick={onClick} style={{ position: "relative", cursor: "pointer", width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6, transition: "background .1s" }}
      onMouseEnter={e => e.currentTarget.style.background = "rgba(87,155,252,.15)"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={count > 0 ? "#579bfc" : "#556"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
      {count > 0 && <div style={{ position: "absolute", top: -2, right: -2, width: 14, height: 14, borderRadius: "50%", background: "#e2445c", color: "#fff", fontSize: 8, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>{count}</div>}
    </div>
  );
}

// ─── COLUMN HEADER ───────────────────────────────────────────────────────────
function ColHeader({ col, onRename, onDelete, onToggleDeadline, onChangeType, onDuplicate, onHide, onSetAutoTime, statusColumns = [], canDelete = true }) {
  const [menu, setMenu] = useState(false);
  const [showTypeMenu, setShowTypeMenu] = useState(false);
  const [showAutoMenu, setShowAutoMenu] = useState(false);
  const ref = useRef(null);
  useClickOutside(ref, () => { setMenu(false); setShowTypeMenu(false); setShowAutoMenu(false); });
  // Nome da coluna de status que este horário observa, para o menu mostrar de
  // relance qual das colunas manda — com duas ou mais, "automático" não basta.
  const autoSourceName = (statusColumns.find(sc => (sc.sourceId || null) === (col.autoTimeSource || null)) || {}).name || "Status";

  const typeIcons = { text: "📝", number: "🔢", date: "📅", time: "🕐", status: "🔵", people: "👥", priority: "🔴" };
  const typeLabels = { text: "Texto", number: "Número", date: "Data", time: "Horário", status: "Status", people: "Pessoas", priority: "Prioridade" };
  const allTypes = ["text", "number", "date", "time", "status", "people", "priority"];

  const menuItem = (icon, label, color, onClick, disabled) => (
    <div onClick={disabled ? undefined : () => { onClick(); setMenu(false); setShowTypeMenu(false); }}
      style={{ padding: "7px 10px", borderRadius: 6, cursor: disabled ? "default" : "pointer", fontSize: 12, color: disabled ? "#444" : (color || "#e8eaed"), display: "flex", alignItems: "center", gap: 7, opacity: disabled ? 0.5 : 1 }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = "rgba(255,255,255,.05)"; }}
      onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
      <span style={{ fontSize: 13, width: 18, textAlign: "center" }}>{icon}</span> {label}
    </div>
  );

  return (
    <div ref={ref} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 3, position: "relative", userSelect: "none", width: "100%", height: "100%" }}>
      <EditText value={col.name} onChange={onRename ? v => onRename(v) : undefined} style={{ fontSize: 11, fontWeight: 600, color: "#9ca6b5", textAlign: "center" }} />
      <span onClick={(e) => { e.stopPropagation(); setMenu(!menu); setShowTypeMenu(false); }} style={{ cursor: "pointer", fontSize: 14, color: "#778ca3", padding: "0 2px", lineHeight: 1, fontWeight: 700 }}>⋮</span>
      {menu && (
        <div style={{ position: "absolute", top: "100%", right: -10, marginTop: 4, background: "#2a2d35", borderRadius: 10, padding: 6, minWidth: 200, zIndex: 50, boxShadow: "0 8px 24px rgba(0,0,0,.6)", border: "1px solid #3a3d45" }}>
          {/* Current type indicator */}
          <div style={{ padding: "6px 10px", fontSize: 11, color: "#556", display: "flex", alignItems: "center", gap: 6, borderBottom: "1px solid #333", marginBottom: 4, paddingBottom: 8 }}>
            <span>{typeIcons[col.type] || "📝"}</span> Tipo: <span style={{ color: "#9ca6b5", fontWeight: 600 }}>{typeLabels[col.type] || col.type}</span>
          </div>

          {/* Change type */}
          <div style={{ position: "relative" }}>
            <div onClick={(e) => { e.stopPropagation(); setShowTypeMenu(!showTypeMenu); }}
              style={{ padding: "7px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12, color: "#e8eaed", display: "flex", alignItems: "center", gap: 7, justifyContent: "space-between" }}
              onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,.05)"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <span style={{ display: "flex", alignItems: "center", gap: 7 }}><span style={{ fontSize: 13, width: 18, textAlign: "center" }}>🔄</span> Alterar tipo</span>
              <span style={{ fontSize: 10, color: "#556" }}>▶</span>
            </div>
            {showTypeMenu && (
              <div style={{ position: "absolute", left: "100%", top: -4, marginLeft: 4, background: "#2a2d35", borderRadius: 10, padding: 6, minWidth: 160, zIndex: 55, boxShadow: "0 8px 24px rgba(0,0,0,.6)", border: "1px solid #3a3d45" }}>
                {allTypes.map(t => {
                  const isCurrent = t === col.type;
                  return (
                    <div key={t} onClick={() => { if (!isCurrent && onChangeType) { onChangeType(t); setMenu(false); setShowTypeMenu(false); } }}
                      style={{ padding: "6px 10px", borderRadius: 6, cursor: isCurrent ? "default" : "pointer", fontSize: 12, color: isCurrent ? "#6c5ce7" : "#e8eaed", display: "flex", alignItems: "center", gap: 7, background: isCurrent ? "rgba(108,92,231,.1)" : "transparent", fontWeight: isCurrent ? 600 : 400 }}
                      onMouseEnter={e => { if (!isCurrent) e.currentTarget.style.background = "rgba(255,255,255,.05)"; }}
                      onMouseLeave={e => { if (!isCurrent) e.currentTarget.style.background = "transparent"; }}>
                      <span style={{ fontSize: 13, width: 18, textAlign: "center" }}>{typeIcons[t]}</span> {typeLabels[t]}
                      {isCurrent && <span style={{ marginLeft: "auto", fontSize: 11 }}>✓</span>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Toggle deadline (date only) */}
          {col.type === "date" && menuItem(col.isDeadline ? "⏰" : "⏰", col.isDeadline ? "Desativar prazo" : "Ativar como prazo", "#fdab3d", onToggleDeadline)}

          {/* Preenchimento automático (horário apenas). O quadro pode ter mais de
              uma coluna de status — "Status Arte", "Status Produção" — então a
              escolha é sempre par: qual status observar e se marca início ou fim. */}
          {col.type === "time" && onSetAutoTime && (
            <div style={{ position: "relative" }}>
              <div onClick={(e) => { e.stopPropagation(); setShowAutoMenu(!showAutoMenu); }}
                style={{ padding: "7px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12, color: "#e8eaed", display: "flex", alignItems: "center", gap: 7, justifyContent: "space-between" }}
                onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,.05)"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <span style={{ fontSize: 13, width: 18, textAlign: "center" }}>⏱</span>
                  {col.autoTime ? `${col.autoTime === "start" ? "Início" : "Fim"} · ${autoSourceName}` : "Preenchimento automático"}
                </span>
                <span style={{ fontSize: 10, color: "#556" }}>▶</span>
              </div>
              {showAutoMenu && (
                <div style={{ position: "absolute", left: "100%", top: -4, marginLeft: 4, background: "#2a2d35", borderRadius: 10, padding: 6, minWidth: 210, zIndex: 55, boxShadow: "0 8px 24px rgba(0,0,0,.6)", border: "1px solid #3a3d45" }}>
                  <div onClick={() => { onSetAutoTime(null, null); setMenu(false); setShowAutoMenu(false); }}
                    style={{ padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12, color: !col.autoTime ? "#6c5ce7" : "#e8eaed", fontWeight: !col.autoTime ? 600 : 400, display: "flex", alignItems: "center", gap: 7 }}
                    onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,.05)"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <span style={{ width: 18, textAlign: "center" }}>✎</span> Manual
                    {!col.autoTime && <span style={{ marginLeft: "auto", fontSize: 11 }}>✓</span>}
                  </div>
                  {statusColumns.length === 0 && (
                    <div style={{ padding: "6px 10px", fontSize: 11, color: "#556" }}>Nenhuma coluna de status neste quadro.</div>
                  )}
                  {statusColumns.map(sc => (
                    <div key={sc.id}>
                      <div style={{ padding: "6px 10px 2px", fontSize: 10, color: "#556", fontWeight: 700, textTransform: "uppercase", letterSpacing: .3 }}>{sc.name}</div>
                      {[{ slot: "start", label: 'Início — ao virar "Em andamento"' }, { slot: "end", label: 'Fim — ao virar "Feito"' }].map(o => {
                        const active = col.autoTime === o.slot && (col.autoTimeSource || null) === (sc.sourceId || null);
                        return (
                          <div key={o.slot} onClick={() => { onSetAutoTime(o.slot, sc.sourceId || null); setMenu(false); setShowAutoMenu(false); }}
                            style={{ padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12, color: active ? "#00c875" : "#e8eaed", fontWeight: active ? 600 : 400, background: active ? "rgba(0,200,117,.1)" : "transparent", display: "flex", alignItems: "center", gap: 7 }}
                            onMouseEnter={e => { if (!active) e.currentTarget.style.background = "rgba(255,255,255,.05)"; }}
                            onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent"; }}>
                            <span style={{ width: 18, textAlign: "center" }}>{o.slot === "start" ? "▶" : "⏹"}</span> {o.label}
                            {active && <span style={{ marginLeft: "auto", fontSize: 11 }}>✓</span>}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Duplicate */}
          {onDuplicate && menuItem("📋", "Duplicar coluna", "#579bfc", onDuplicate)}

          {/* Hide in this task */}
          {onHide && menuItem("🙈", "Ocultar nesta tarefa", "#a5b1c2", onHide)}

          {/* Divider before delete */}
          <div style={{ height: 1, background: "#333", margin: "4px 0" }} />

          {/* Delete */}
          {canDelete && onDelete && menuItem("🗑", "Excluir coluna", "#e2445c", onDelete)}
          {!canDelete && (
            <div style={{ padding: "7px 10px", fontSize: 12, color: "#444", display: "flex", alignItems: "center", gap: 7 }}>
              <LockedOverlay /> Excluir (restrito a admins)
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── ADD COLUMN MODAL ────────────────────────────────────────────────────────
function AddColumnModal({ onClose, onAdd, columns, title: modalTitle, linkParent }) {
  const [name, setName] = useState(""); const [type, setType] = useState("text"); const [isDeadline, setIsDeadline] = useState(false); const [copyFrom, setCopyFrom] = useState(""); const [parentFor, setParentFor] = useState(""); const [autoTime, setAutoTime] = useState(null); const [autoTimeSource, setAutoTimeSource] = useState(null);
  const types = [{ value: "text", label: "Texto", icon: "📝" }, { value: "number", label: "Número", icon: "🔢" }, { value: "date", label: "Data", icon: "📅" }, { value: "time", label: "Horário", icon: "🕐" }, { value: "status", label: "Status", icon: "🔵" }, { value: "people", label: "Pessoas", icon: "👥" }, { value: "priority", label: "Prioridade", icon: "🔴" }];
  const numericParents = linkParent ? columns.filter(c => c.type === "number") : [];
  const statusSources = statusSourceList(columns);
  const sourceLabel = (statusSources.find(sc => (sc.sourceId || null) === (autoTimeSource || null)) || {}).name || "Status";
  const handleAdd = () => { if (!name.trim()) return; const id = "col_" + Date.now(); const col = { id, name: name.trim(), type, field: id, builtIn: false, isDeadline: type === "date" && isDeadline, autoTime: type === "time" ? autoTime : null, autoTimeSource: type === "time" && autoTime ? autoTimeSource : null, width: type === "people" ? "110px" : type === "status" || type === "priority" ? "110px" : type === "date" ? "100px" : type === "time" ? "90px" : "80px" }; if (linkParent && type === "number" && parentFor) col.parentColumnId = parentFor; onAdd(col); onClose(); };
  const handleCopy = () => { if (!copyFrom) return; const src = columns.find(c => c.id === copyFrom); if (!src) return; const id = "col_" + Date.now(); const col = { ...src, id, field: id, name: src.name + " (cópia)", builtIn: false }; if (linkParent) col.parentColumnId = src.id; onAdd(col); onClose(); };
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, backdropFilter: "blur(4px)" }} onClick={onClose}>
      <div style={{ background: "#23262e", borderRadius: 14, padding: 26, width: 440, maxWidth: "92vw", border: "1px solid #333" }} onClick={e => e.stopPropagation()}>
        <div style={{ fontWeight: 700, fontSize: 17, marginBottom: 18 }}>{modalTitle || "Adicionar Coluna"}</div>
        <div style={{ background: "#1a1d23", borderRadius: 10, padding: 14, marginBottom: 16, border: "1px solid #333" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#a5b1c2", marginBottom: 6 }}>📋 Copiar coluna existente</div>
          <div style={{ display: "flex", gap: 8 }}>
            <select value={copyFrom} onChange={e => setCopyFrom(e.target.value)} style={{ flex: 1, padding: "8px 10px", borderRadius: 8, border: "1px solid #444", background: "#13151a", color: "#e8eaed", fontSize: 12 }}><option value="">Selecionar...</option>{columns.map(c => <option key={c.id} value={c.id}>{c.name} ({c.type})</option>)}</select>
            <button onClick={handleCopy} disabled={!copyFrom} style={{ background: copyFrom ? "#579bfc" : "#333", color: "#fff", border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 12, fontWeight: 600, cursor: copyFrom ? "pointer" : "default" }}>Duplicar</button>
          </div>
        </div>
        <div style={{ fontSize: 12, color: "#556", textAlign: "center", marginBottom: 12 }}>— ou criar nova —</div>
        <div style={{ marginBottom: 12 }}><label style={{ fontSize: 12, color: "#778ca3", fontWeight: 600, display: "block", marginBottom: 4 }}>Nome</label><input value={name} onChange={e => setName(e.target.value)} placeholder="Ex: Observações" style={{ width: "100%", padding: "9px 11px", borderRadius: 8, border: "1px solid #444", background: "#1a1d23", color: "#e8eaed", fontSize: 13, outline: "none", boxSizing: "border-box" }} autoFocus /></div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 12 }}>
          {types.map(t => (<div key={t.value} onClick={() => setType(t.value)} style={{ padding: "10px 8px", borderRadius: 8, border: type === t.value ? "2px solid #6c5ce7" : "1px solid #3a3d45", background: type === t.value ? "rgba(108,92,231,.12)" : "#1a1d23", cursor: "pointer", textAlign: "center" }}><div style={{ fontSize: 18 }}>{t.icon}</div><div style={{ fontSize: 11, fontWeight: 600, color: "#e8eaed", marginTop: 2 }}>{t.label}</div></div>))}
        </div>
        {type === "date" && (<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 10px", background: "#1a1d23", borderRadius: 8, marginBottom: 12, border: "1px solid #333" }}><div><div style={{ fontSize: 12, fontWeight: 600, color: "#e8eaed" }}>Usar como prazo</div></div><div onClick={() => setIsDeadline(!isDeadline)} style={{ width: 36, height: 18, borderRadius: 9, background: isDeadline ? "#6c5ce7" : "#444", cursor: "pointer", position: "relative" }}><div style={{ width: 14, height: 14, borderRadius: "50%", background: "#fff", position: "absolute", top: 2, left: isDeadline ? 20 : 2, transition: "left .2s" }} /></div></div>)}
        {type === "time" && (
          <div style={{ padding: "10px 12px", background: "#1a1d23", borderRadius: 8, marginBottom: 12, border: "1px solid #333" }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#e8eaed", marginBottom: 2 }}>Preenchimento automático</div>
            <div style={{ fontSize: 11, color: "#778ca3", marginBottom: 8 }}>A hora do servidor entra sozinha quando o status muda. Só preenche se estiver vazio.</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
              {[{ v: null, label: "Manual" }, { v: "start", label: "Início" }, { v: "end", label: "Fim" }].map(o => (
                <div key={o.label} onClick={() => setAutoTime(o.v)}
                  style={{ padding: "8px 6px", borderRadius: 8, border: autoTime === o.v ? "2px solid #00c875" : "1px solid #3a3d45", background: autoTime === o.v ? "rgba(0,200,117,.12)" : "#13151a", cursor: "pointer", textAlign: "center", fontSize: 11, fontWeight: 600, color: "#e8eaed" }}>
                  {o.label}
                </div>
              ))}
            </div>
            {autoTime && (<>
              {/* Com mais de uma coluna de status no quadro é obrigatório dizer
                  qual delas manda, senão as duas disputariam o mesmo relógio. */}
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 11, color: "#778ca3", fontWeight: 600, marginBottom: 4 }}>Seguir qual coluna de status?</div>
                <select value={autoTimeSource === null ? "__native__" : autoTimeSource}
                  onChange={e => setAutoTimeSource(e.target.value === "__native__" ? null : e.target.value)}
                  style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid #444", background: "#13151a", color: "#e8eaed", fontSize: 12 }}>
                  {statusSources.length === 0 && <option value="__native__">Status</option>}
                  {statusSources.map(sc => (
                    <option key={sc.id} value={sc.sourceId === null ? "__native__" : sc.sourceId}>{sc.name}</option>
                  ))}
                </select>
              </div>
              <div style={{ fontSize: 11, color: "#00c875", marginTop: 8 }}>
                Preenche quando “{sourceLabel}” virar “{autoTime === "start" ? "Em andamento" : "Feito"}”, e zera na virada do dia.
              </div>
            </>)}
          </div>
        )}
        {linkParent && type === "number" && numericParents.length > 0 && (
          <div style={{ padding: "8px 10px", background: "#1a1d23", borderRadius: 8, marginBottom: 12, border: "1px solid #333" }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#a5b1c2", marginBottom: 6 }}>Σ Somar na coluna pai</div>
            <select value={parentFor} onChange={e => setParentFor(e.target.value)} style={{ width: "100%", padding: "7px 9px", borderRadius: 6, border: "1px solid #444", background: "#13151a", color: "#e8eaed", fontSize: 12 }}>
              <option value="">Nenhuma (coluna independente)</option>
              {numericParents.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button onClick={onClose} style={{ padding: "9px 18px", borderRadius: 8, border: "1px solid #444", background: "transparent", color: "#a5b1c2", fontSize: 13, cursor: "pointer" }}>Cancelar</button>
          <button onClick={handleAdd} disabled={!name.trim()} style={{ padding: "9px 22px", borderRadius: 8, border: "none", background: name.trim() ? "#6c5ce7" : "#333", color: "#fff", fontSize: 13, fontWeight: 600, cursor: name.trim() ? "pointer" : "default" }}>Adicionar</button>
        </div>
      </div>
    </div>
  );
}

// ─── DRAG & DROP HOOK ────────────────────────────────────────────────────────
function useDragReorder(items, setItems) {
  const dragItem = useRef(null);
  const dragOver = useRef(null);
  const [dragging, setDragging] = useState(null);

  const onDragStart = (idx) => { dragItem.current = idx; setDragging(idx); };
  const onDragEnter = (idx) => { dragOver.current = idx; };
  const onDragEnd = () => {
    if (dragItem.current === null || dragOver.current === null || dragItem.current === dragOver.current) { setDragging(null); dragItem.current = null; dragOver.current = null; return; }
    const copy = [...items];
    const [moved] = copy.splice(dragItem.current, 1);
    copy.splice(dragOver.current, 0, moved);
    setItems(copy);
    dragItem.current = null;
    dragOver.current = null;
    setDragging(null);
  };
  return { dragging, onDragStart, onDragEnter, onDragEnd };
}

// Drag handle grip icon
function DragGrip({ style = {} }) {
  return (
    <div style={{ cursor: "grab", display: "flex", alignItems: "center", justifyContent: "center", color: "#444", fontSize: 11, padding: "0 2px", userSelect: "none", ...style }}
      onMouseEnter={e => e.currentTarget.style.color = "#778ca3"} onMouseLeave={e => e.currentTarget.style.color = "#444"}>
      ⠿
    </div>
  );
}

// ─── COLUMN RESIZE HANDLE ────────────────────────────────────────────────────
function ResizeHandle({ onResize }) {
  const startX = useRef(0);
  const startW = useRef(0);
  const active = useRef(false);

  const onMouseDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    startX.current = e.clientX;
    const cell = e.target.parentElement;
    startW.current = cell ? cell.offsetWidth : 80;
    active.current = true;

    const onMouseMove = (ev) => {
      if (!active.current) return;
      const delta = ev.clientX - startX.current;
      const newW = Math.max(50, startW.current + delta);
      onResize(newW);
    };
    const onMouseUp = () => {
      active.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div onMouseDown={onMouseDown} style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 5, cursor: "col-resize", zIndex: 2, background: "transparent" }}
      onMouseEnter={e => e.currentTarget.style.background = "rgba(87,155,252,.4)"}
      onMouseLeave={e => { if (!active.current) e.currentTarget.style.background = "transparent"; }} />
  );
}

// ─── INLINE ADD ROW ──────────────────────────────────────────────────────────
function InlineAddRow({ placeholder, onAdd, gridCols, cellBorder, cellStyle, accentColor, indent }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const ref = useRef(null);

  useEffect(() => { if (editing && ref.current) ref.current.focus(); }, [editing]);

  const commit = () => {
    if (name.trim()) { onAdd(name.trim()); setName(""); }
    setEditing(false);
  };

  if (!editing) return (
    <div onClick={() => setEditing(true)}
      style={{ display: "grid", gridTemplateColumns: gridCols, gap: 0, borderBottom: cellBorder, cursor: "pointer", transition: "background .1s", background: "transparent" }}
      onMouseEnter={e => e.currentTarget.style.background = "#1a1e26"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
      {indent ? <div style={{ ...cellStyle({ borderRight: "none" }) }} /> : null}
      <div style={{ ...cellStyle({ borderRight: "none", justifyContent: "flex-start", paddingLeft: indent ? 20 : 46, gap: 6, height: 34, color: "#556" }), gridColumn: indent ? "2 / -1" : "1 / -1" }}>
        <span style={{ color: accentColor || "#579bfc", fontSize: 14, fontWeight: 700 }}>+</span>
        <span style={{ fontSize: 12, color: "#556" }}>{placeholder}</span>
      </div>
    </div>
  );

  return (
    <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 0, borderBottom: cellBorder, background: "#1a2030" }}>
      {indent ? <div style={{ ...cellStyle({ borderRight: "none" }) }} /> : null}
      <div style={{ ...cellStyle({ borderRight: "none", justifyContent: "flex-start", paddingLeft: indent ? 20 : 46, gap: 6, height: 34 }), gridColumn: indent ? "2 / -1" : "1 / -1" }}>
        <span style={{ color: accentColor || "#579bfc", fontSize: 14, fontWeight: 700 }}>+</span>
        <input ref={ref} value={name} onChange={e => setName(e.target.value)}
          onBlur={commit} onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setName(""); setEditing(false); } }}
          placeholder={placeholder} style={{ flex: 1, background: "transparent", border: "none", color: "#e8eaed", fontSize: 13, outline: "none", padding: "2px 0" }} />
      </div>
    </div>
  );
}

// ─── BOARD VIEW (Monday.com style) ───────────────────────────────────────────
// Destaque de linha alterada: fica pulsando até o usuário clicar na linha.
const HOT_BG = "#33290f";
const HOT_ROW = { animation: "hotRow 1.5s ease-in-out infinite" };

function BoardView({ tasks, setTasks, apiUpdateTask, apiUpdateSub, apiAddTask, apiDeleteTask, apiAddSubitem, search, allPeople, columns, setColumns, apiUpdateColumn, apiDeleteColumn, apiReorderColumns, apiReorderTasks, apiReorderSubitems, setShowAddCol, subColumns, setSubColumns, apiUpdateSubColumn, apiDeleteSubColumn, apiReorderSubColumns, setShowAddSubCol, setActiveSubColTaskId, onOpenUpdates, perms = {}, highlights = {}, onClearHighlight = () => {} }) {
  const [expanded, setExpanded] = useState({});
  const [selected, setSelected] = useState({});
  const [groupOpen, setGroupOpen] = useState(true);
  const [taskColWidth, setTaskColWidth] = useState(280);

  // Subitem destacado precisa ficar visível: abre a tarefa pai automaticamente.
  useEffect(() => {
    const subIds = new Set(Object.keys(highlights).filter(k => k.startsWith("s:")).map(k => k.slice(2)));
    if (subIds.size === 0) return;
    setExpanded(prev => {
      let next = prev;
      tasks.forEach(t => {
        if (!prev[t.id] && (t.subitems || []).some(s => subIds.has(s.id))) {
          if (next === prev) next = { ...prev };
          next[t.id] = true;
        }
      });
      return next;
    });
  }, [highlights, tasks]);

  // A ordem já vem pronta do estado: é definida ao abrir o quadro e reaplicada
  // sozinha quando o usuário para de mexer (ver reordenação ociosa no
  // Dashboard). Aqui só filtramos pela busca — reordenar a cada render faria a
  // linha fugir debaixo do cursor no instante do clique.
  const filtered = useMemo(() => {
    if (!search) return tasks;
    const q = search.toLowerCase();
    return tasks.filter(t => t.name.toLowerCase().includes(q) || (t.responsible || []).some(r => r.toLowerCase().includes(q)) || t.subitems.some(s => s.name.toLowerCase().includes(q)));
  }, [tasks, search]);
  const upTask = (tid, nt) => { if (apiUpdateTask) apiUpdateTask(tid, nt); else setTasks(prev => prev.map(t => t.id === tid ? (typeof nt === "function" ? nt(t) : nt) : t)); };
  const upSub = (tid, sid, ns) => { if (apiUpdateSub) apiUpdateSub(tid, sid, ns); else setTasks(prev => prev.map(t => t.id === tid ? { ...t, subitems: t.subitems.map(s => s.id === sid ? (typeof ns === "function" ? ns(s) : ns) : s) } : t)); };

  // Column resize helper
  const resizeCol = (colId, newW, setter) => {
    setter(prev => prev.map(c => c.id === colId ? { ...c, width: newW + "px" } : c));
  };

  // Drag for columns
  const colDrag = useDragReorder(columns, (newCols) => { setColumns(newCols); if (apiReorderColumns) apiReorderColumns(newCols.map(c => c.id)); });
  // Drag for tasks
  const taskDrag = useDragReorder(filtered, (newFiltered) => {
    if (!search) { setTasks(newFiltered); if (apiReorderTasks) apiReorderTasks(newFiltered.map(t => t.id)); return; }
    const ids = newFiltered.map(t => t.id);
    setTasks(prev => {
      const rest = prev.filter(t => !ids.includes(t.id));
      const merged = [...newFiltered, ...rest];
      if (apiReorderTasks) apiReorderTasks(merged.map(t => t.id));
      return merged;
    });
  });

  const allCols = columns;
  const colWidths = allCols.map(c => c.width || "80px").join(" ");
  const gridCols = `20px 32px 24px 28px ${taskColWidth}px ${colWidths} 32px`;
  const subBaseCols = `20px 28px ${taskColWidth}px ${colWidths}`;

  const cellBorder = "1px solid #2a2d35";
  const hdrStyle = (extra = {}) => ({ padding: "0 6px", fontSize: 11, fontWeight: 600, color: "#9ca6b5", background: "#1e2028", borderBottom: "1px solid #333", borderRight: cellBorder, display: "flex", alignItems: "center", justifyContent: "center", height: 36, textAlign: "center", position: "relative", ...extra });
  const cellStyle = (extra = {}) => ({ padding: "0 6px", display: "flex", alignItems: "center", justifyContent: "center", borderRight: cellBorder, height: 38, ...extra });

  const GROUP_COLOR = "#579bfc";

  return (
    <div style={{ overflowX: "auto" }}>
      {/* ── GROUP HEADER ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 4px 6px", cursor: "pointer" }} onClick={() => setGroupOpen(!groupOpen)}>
        <span style={{ color: GROUP_COLOR, fontSize: 12, transform: groupOpen ? "rotate(90deg)" : "rotate(0deg)", transition: "transform .2s", display: "inline-block" }}>▶</span>
        <span style={{ color: GROUP_COLOR, fontWeight: 800, fontSize: 16 }}>Tarefas pendentes</span>
        <span style={{ color: "#556", fontSize: 12 }}>{filtered.length} itens</span>
      </div>

      {groupOpen && (
        <div style={{ borderRadius: 8, overflow: "hidden", border: "1px solid #2a2d35" }}>
          {/* ── COLUMN HEADERS ── */}
          <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 0, position: "sticky", top: 0, zIndex: 5 }}>
            <div style={hdrStyle()} />
            <div style={{ ...hdrStyle(), borderLeft: `3px solid ${GROUP_COLOR}` }}>
              <input type="checkbox" style={{ accentColor: GROUP_COLOR, cursor: "pointer", width: 14, height: 14 }}
                onChange={e => { const v = e.target.checked; const s = {}; filtered.forEach(t => s[t.id] = v); setSelected(s); }} />
            </div>
            <div style={hdrStyle()}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#9ca6b5" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            </div>
            <div style={hdrStyle()} />
            <div style={{ ...hdrStyle({ justifyContent: "flex-start", paddingLeft: 12, fontWeight: 700 }) }}>Tarefa<ResizeHandle onResize={(w) => setTaskColWidth(Math.max(150, w))} /></div>
            {allCols.map((col, ci) => (
              <div key={col.id}
                draggable
                onDragStart={() => colDrag.onDragStart(ci)}
                onDragEnter={() => colDrag.onDragEnter(ci)}
                onDragEnd={colDrag.onDragEnd}
                onDragOver={e => e.preventDefault()}
                style={{ ...hdrStyle(), cursor: "grab", opacity: colDrag.dragging === ci ? 0.4 : 1, transition: "opacity .15s" }}>
                <ColHeader col={col}
                  onRename={v => { setColumns(p => p.map(c => c.id === col.id ? { ...c, name: v } : c)); if (apiUpdateColumn) apiUpdateColumn(col.id, { name: v }); }}
                  onDelete={!col.builtIn && perms.deleteColumns ? () => { if (apiDeleteColumn) apiDeleteColumn(col.id); else setColumns(p => p.filter(c => c.id !== col.id)); } : null}
                  onToggleDeadline={() => { const nv = !col.isDeadline; setColumns(p => p.map(c => c.id === col.id ? { ...c, isDeadline: nv } : c)); if (apiUpdateColumn) apiUpdateColumn(col.id, { isDeadline: nv }); }}
                  onSetAutoTime={apiUpdateColumn ? (v, src) => { setColumns(p => p.map(c => c.id === col.id ? { ...c, autoTime: v, autoTimeSource: src } : c)); apiUpdateColumn(col.id, { autoTime: v, autoTimeSource: src }); } : null}
                  statusColumns={statusSourceList(columns)}
                  onChangeType={(newType) => { setColumns(p => p.map(c => c.id === col.id ? { ...c, type: newType, isDeadline: newType === "date" ? c.isDeadline : false, autoTime: newType === "time" ? c.autoTime : null } : c)); if (apiUpdateColumn) apiUpdateColumn(col.id, { type: newType }); }}
                  onDuplicate={() => { const newId = "col_" + Date.now(); const dup = { ...col, id: newId, field: newId, name: col.name + " (cópia)", builtIn: false }; setColumns(p => [...p, dup]); if (apiUpdateColumn) apiCall("/columns", { method: "POST", body: JSON.stringify(dup) }); }}
                  canDelete={col.builtIn ? true : perms.deleteColumns}
                />
                <ResizeHandle onResize={(w) => { setColumns(prev => prev.map(c => c.id === col.id ? { ...c, width: w + "px" } : c)); if (apiUpdateColumn) apiUpdateColumn(col.id, { width: w + "px" }); }} />
              </div>
            ))}
            {perms.addColumns ? (
              <div onClick={() => setShowAddCol(true)} style={{ ...hdrStyle({ cursor: "pointer", color: "#579bfc", fontSize: 16, fontWeight: 700, borderRight: "none" }) }}>+</div>
            ) : (
              <div style={{ ...hdrStyle({ borderRight: "none" }) }}><LockedOverlay /></div>
            )}
          </div>

          {/* ── TASK ROWS ── */}
          {filtered.map((task, ti) => {
            const isOpen = expanded[task.id];
            const dc = task.subitems.filter(s => s.status === "Feito").length;
            const subCount = task.subitems.length;
            const isDraggingTask = taskDrag.dragging === ti;
            const hlKey = `t:${task.id}`;
            const isHot = !!highlights[hlKey];
            const restBg = isHot ? HOT_BG : (selected[task.id] ? "#1a2a40" : "#1e2028");

            // Sub drag for this task's subitems
            const subReorder = (newSubs) => { setTasks(prev => prev.map(t => t.id === task.id ? { ...t, subitems: newSubs } : t)); if (apiReorderSubitems) apiReorderSubitems(task.id, newSubs.map(s => s.id)); };

            return (
              <div key={task.id} data-flip-id={`t:${task.id}`}>
                <div
                  draggable
                  onDragStart={() => taskDrag.onDragStart(ti)}
                  onDragEnter={() => taskDrag.onDragEnter(ti)}
                  onDragEnd={taskDrag.onDragEnd}
                  onDragOver={e => e.preventDefault()}
                  onClick={() => { if (isHot) onClearHighlight(hlKey); }}
                  style={{ display: "grid", gridTemplateColumns: gridCols, gap: 0, background: restBg, borderBottom: cellBorder, transition: "all .15s", opacity: isDraggingTask ? 0.4 : 1, ...(isHot ? HOT_ROW : null) }}
                  onMouseEnter={e => { if (!isHot && !selected[task.id] && !isDraggingTask) e.currentTarget.style.background = "#232730"; }}
                  onMouseLeave={e => { if (!isHot && !selected[task.id]) e.currentTarget.style.background = "#1e2028"; }}>
                  
                  {/* Drag handle */}
                  <div style={{ ...cellStyle(), cursor: "grab", padding: 0 }}>
                    <DragGrip />
                  </div>

                  {/* Checkbox */}
                  <div style={{ ...cellStyle(), borderLeft: `3px solid ${GROUP_COLOR}`, justifyContent: "center" }}>
                    <input type="checkbox" checked={!!selected[task.id]} onChange={() => setSelected(p => ({ ...p, [task.id]: !p[task.id] }))} style={{ accentColor: GROUP_COLOR, cursor: "pointer", width: 14, height: 14 }} />
                  </div>

                  {/* Chat bubble */}
                  <div style={cellStyle()}>
                    <ChatBubble count={(task.updates || []).length} onClick={() => onOpenUpdates(task.id)} />
                  </div>

                  {/* Expand arrow */}
                  <div style={{ ...cellStyle(), cursor: "pointer" }} onClick={() => setExpanded(p => ({ ...p, [task.id]: !p[task.id] }))}>
                    <span style={{ color: "#778ca3", fontSize: 11, transform: isOpen ? "rotate(90deg)" : "rotate(0)", transition: "transform .15s", display: "inline-block" }}>▶</span>
                  </div>

                  {/* Task name */}
                  <div style={{ ...cellStyle({ justifyContent: "flex-start", paddingLeft: 10, gap: 8 }) }}>
                    <EditText value={task.name} onChange={v => upTask(task.id, { ...task, name: v })} style={{ fontWeight: 600, color: "#e8eaed", fontSize: 13.5 }} />
                    {subCount > 0 && (
                      <span style={{ background: "#333", color: "#9ca6b5", fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 8, flexShrink: 0 }}>{subCount}</span>
                    )}
                    {perms.deleteTasks && apiDeleteTask && (
                      <button
                        title={`Excluir tarefa "${task.name}"`}
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (!window.confirm(`Excluir a tarefa "${task.name}"? Todos os subitens, relatórios e dados associados serão removidos. Esta ação não pode ser desfeita.`)) return;
                          const r = await apiDeleteTask(task.id);
                          if (r?.error) alert(r.error);
                        }}
                        style={{ marginLeft: "auto", background: "transparent", border: "none", color: "#444", cursor: "pointer", fontSize: 13, padding: "2px 6px", borderRadius: 4, opacity: 0.6, transition: "all .15s" }}
                        onMouseEnter={(e) => { e.currentTarget.style.color = "#e2445c"; e.currentTarget.style.opacity = 1; e.currentTarget.style.background = "rgba(226,68,92,.08)"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.color = "#444"; e.currentTarget.style.opacity = 0.6; e.currentTarget.style.background = "transparent"; }}
                      >🗑</button>
                    )}
                  </div>

                  {/* Dynamic columns */}
                  {allCols.map(col => (
                    <div key={col.id} style={cellStyle()}>
                      <CellRenderer col={col} item={task} onChange={ni => upTask(task.id, ni)} allPeople={allPeople} subitems={task.subitems} subColumns={subColumns.filter(sc => sc.taskId === task.id)} taskColumns={allCols} />
                    </div>
                  ))}

                  <div style={{ ...cellStyle({ borderRight: "none" }) }} />
                </div>

                {/* ── SUBITEMS ── */}
                {isOpen && (
                  <SubitemsBlock highlights={highlights} onClearHighlight={onClearHighlight} task={task} allCols={allCols} subColumns={subColumns} setSubColumns={setSubColumns} apiUpdateSubColumn={apiUpdateSubColumn} apiDeleteSubColumn={apiDeleteSubColumn} apiReorderSubColumns={apiReorderSubColumns} setColumns={setColumns} apiUpdateColumn={apiUpdateColumn} apiDeleteColumn={apiDeleteColumn} taskColWidth={taskColWidth} cellBorder={cellBorder} hdrStyle={hdrStyle} cellStyle={cellStyle} upTask={upTask} upSub={upSub} onOpenUpdates={onOpenUpdates} allPeople={allPeople} perms={perms} setShowAddSubCol={setShowAddSubCol} setActiveSubColTaskId={setActiveSubColTaskId} subReorder={subReorder} apiAddSubitem={apiAddSubitem} />
                )}
              </div>
            );
          })}

          {/* Inline add task row */}
          <InlineAddRow placeholder="Adicionar tarefa" gridCols={gridCols} cellBorder={cellBorder} cellStyle={cellStyle} accentColor="#579bfc"
            onAdd={(name) => {
              const newTask = { id: "t" + Date.now(), name, responsible: [], status: "Não iniciado", priority: "Média", deadline: null, totalOrders: 0, totalCancellations: 0, custom: {}, updates: [], subitems: [] };
              if (apiAddTask) apiAddTask(newTask); else setTasks(prev => [...prev, newTask]);
            }} />
        </div>
      )}
    </div>
  );
}

// Extracted subitems block to use its own drag hook
function SubitemsBlock({ highlights = {}, onClearHighlight = () => {}, task, allCols, subColumns, setSubColumns, apiUpdateSubColumn, apiDeleteSubColumn, apiReorderSubColumns, setColumns, apiUpdateColumn, apiDeleteColumn, taskColWidth, cellBorder, hdrStyle, cellStyle, upTask, upSub, onOpenUpdates, allPeople, perms, setShowAddSubCol, setActiveSubColTaskId, subReorder, apiAddSubitem }) {
  // Mesma regra das tarefas: a ordem já vem congelada do estado, reaplicada
  // pela reordenação ociosa do Dashboard — nunca no instante do clique.
  const subitems = task.subitems || [];
  const subDrag = useDragReorder(subitems, subReorder);
  const resizeC = (colId, newW, setter) => setter(prev => prev.map(c => c.id === colId ? { ...c, width: newW + "px" } : c));
  const taskSubColumns = subColumns.filter(sc => sc.taskId === task.id);
  const subColDrag = useDragReorder(taskSubColumns, (newTaskSubCols) => {
    if (apiReorderSubColumns) apiReorderSubColumns(task.id, newTaskSubCols.map(c => c.id));
    else setSubColumns(prev => [...prev.filter(sc => sc.taskId !== task.id), ...newTaskSubCols]);
  });
  const hiddenCols = (task.custom && task.custom.hiddenSubCols) || [];
  const visibleAllCols = allCols.filter(c => !hiddenCols.includes(c.id));
  const HIDEABLE_NATIVE = ["col_orders", "col_cancel"];
  const hideInTask = (colId) => {
    const nextHidden = Array.from(new Set([...(hiddenCols), colId]));
    upTask(task.id, { ...task, custom: { ...(task.custom || {}), hiddenSubCols: nextHidden } });
  };
  const unhideInTask = (colId) => {
    const nextHidden = hiddenCols.filter(id => id !== colId);
    upTask(task.id, { ...task, custom: { ...(task.custom || {}), hiddenSubCols: nextHidden } });
  };
  const colWidths = visibleAllCols.map(c => c.width || "80px").join(" ");
  const subExtraCols = taskSubColumns.length > 0 ? " " + taskSubColumns.map(c => c.width || "80px").join(" ") : "";
  const subGridCols = `20px 28px ${taskColWidth}px ${colWidths}${subExtraCols} 32px`;

  return (
    <div>
      {hiddenCols.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 16px", background: "#1a1d23", borderBottom: "1px solid #2a2d35", fontSize: 10, color: "#778ca3" }}>
          <span>Colunas ocultas nesta tarefa:</span>
          {hiddenCols.map(cid => { const c = allCols.find(x => x.id === cid); if (!c) return null; return (
            <span key={cid} onClick={() => unhideInTask(cid)} style={{ cursor: "pointer", background: "#23262e", padding: "2px 8px", borderRadius: 10, border: "1px solid #3a3d45", color: "#9ca6b5", fontWeight: 600 }}
              onMouseEnter={e => e.currentTarget.style.background = "#2f3340"} onMouseLeave={e => e.currentTarget.style.background = "#23262e"}>
              ↺ {c.name}
            </span>
          ); })}
        </div>
      )}
      {/* Subitem column headers — always visible */}
      <div style={{ display: "grid", gridTemplateColumns: subGridCols, gap: 0, background: "#191b20", borderBottom: cellBorder }}>
        <div style={{ borderRight: cellBorder, height: 34 }} />
        <div style={{ borderRight: cellBorder, height: 34 }} />
        <div style={{ ...hdrStyle({ height: 34, fontSize: 10, justifyContent: "flex-start", paddingLeft: 16, background: "#191b20" }) }}>Subitem</div>
        {visibleAllCols.map(col => (
          <div key={col.id} style={{ ...hdrStyle({ height: 34, fontSize: 10, background: "#191b20" }) }}>
            <ColHeader col={col}
              onRename={null}
              onDelete={!col.builtIn && perms.deleteColumns ? () => { if (window.confirm(`Excluir a coluna "${col.name}" de TODAS as tarefas? Essa ação nao pode ser desfeita.`)) { if (apiDeleteColumn) apiDeleteColumn(col.id); else setColumns(p => p.filter(c => c.id !== col.id)); } } : null}
              onToggleDeadline={() => { const nv = !col.isDeadline; setColumns(p => p.map(c => c.id === col.id ? { ...c, isDeadline: nv } : c)); if (apiUpdateColumn) apiUpdateColumn(col.id, { isDeadline: nv }); }}
              onSetAutoTime={apiUpdateColumn ? (v, src) => { setColumns(p => p.map(c => c.id === col.id ? { ...c, autoTime: v, autoTimeSource: src } : c)); apiUpdateColumn(col.id, { autoTime: v, autoTimeSource: src }); } : null}
              statusColumns={statusSourceList(allCols)}
              onChangeType={(newType) => { setColumns(p => p.map(c => c.id === col.id ? { ...c, type: newType, isDeadline: newType === "date" ? c.isDeadline : false, autoTime: newType === "time" ? c.autoTime : null } : c)); if (apiUpdateColumn) apiUpdateColumn(col.id, { type: newType }); }}
              onDuplicate={() => { const newId = "col_" + Date.now(); const dup = { ...col, id: newId, field: newId, name: col.name + " (cópia)", builtIn: false, scope: 'subitem', taskId: task.id, parentColumnId: col.id }; setSubColumns(p => [...p, dup]); apiCall("/columns", { method: "POST", body: JSON.stringify(dup) }); }}
              onHide={HIDEABLE_NATIVE.includes(col.id) && perms.addColumns ? () => hideInTask(col.id) : null}
              canDelete={col.builtIn ? true : perms.deleteColumns}
            />
            <ResizeHandle onResize={(w) => resizeC(col.id, w, setColumns)} />
          </div>
        ))}
        {taskSubColumns.map((sc, sci) => (
          <div key={sc.id}
            draggable
            onDragStart={() => subColDrag.onDragStart(sci)}
            onDragEnter={() => subColDrag.onDragEnter(sci)}
            onDragEnd={subColDrag.onDragEnd}
            onDragOver={e => e.preventDefault()}
            style={{ ...hdrStyle({ height: 34, fontSize: 10, background: "#191b20" }), opacity: subColDrag.dragging === sci ? 0.4 : 1, cursor: "grab" }}>
            <ColHeader col={sc}
              onRename={v => apiUpdateSubColumn ? apiUpdateSubColumn(sc.id, { name: v }) : setSubColumns(p => p.map(c => c.id === sc.id ? { ...c, name: v } : c))}
              onDelete={perms.deleteColumns ? () => apiDeleteSubColumn ? apiDeleteSubColumn(sc.id) : setSubColumns(p => p.filter(c => c.id !== sc.id)) : null}
              onToggleDeadline={() => apiUpdateSubColumn ? apiUpdateSubColumn(sc.id, { isDeadline: !sc.isDeadline }) : setSubColumns(p => p.map(c => c.id === sc.id ? { ...c, isDeadline: !c.isDeadline } : c))}
              onSetAutoTime={apiUpdateSubColumn ? (v, src) => apiUpdateSubColumn(sc.id, { autoTime: v, autoTimeSource: src }) : null}
              statusColumns={statusSourceList([...allCols, ...taskSubColumns])}
              onChangeType={(newType) => apiUpdateSubColumn ? apiUpdateSubColumn(sc.id, { type: newType, isDeadline: newType === "date" ? sc.isDeadline : false }) : setSubColumns(p => p.map(c => c.id === sc.id ? { ...c, type: newType, isDeadline: newType === "date" ? c.isDeadline : false } : c))}
              onDuplicate={() => { const newId = "col_" + Date.now(); const dup = { ...sc, id: newId, field: newId, name: sc.name + " (cópia)", builtIn: false, taskId: task.id }; setSubColumns(p => [...p, dup]); apiCall("/columns", { method: "POST", body: JSON.stringify(dup) }); }}
              canDelete={perms.deleteColumns}
            />
            <ResizeHandle onResize={(w) => { resizeC(sc.id, w, setSubColumns); if (apiUpdateSubColumn) apiUpdateSubColumn(sc.id, { width: w + "px" }); }} />
          </div>
        ))}
        <div style={{ height: 34 }} />
      </div>
      {subitems.map((sub, si) => {
        const hlKey = `s:${sub.id}`;
        const isHot = !!highlights[hlKey];
        return (
        <div key={sub.id}
          data-flip-id={`s:${sub.id}`}
          draggable
          onDragStart={() => subDrag.onDragStart(si)}
          onDragEnter={() => subDrag.onDragEnter(si)}
          onDragEnd={subDrag.onDragEnd}
          onDragOver={e => e.preventDefault()}
          onClick={() => { if (isHot) onClearHighlight(hlKey); }}
          style={{ display: "grid", gridTemplateColumns: subGridCols, gap: 0, background: isHot ? HOT_BG : "#191b20", borderBottom: cellBorder, borderLeft: `3px solid ${isHot ? "#fdab3d" : "#444"}`, marginLeft: 3, transition: "all .15s", opacity: subDrag.dragging === si ? 0.4 : 1, ...(isHot ? HOT_ROW : null) }}
          onMouseEnter={e => { if (!isHot && subDrag.dragging !== si) e.currentTarget.style.background = "#1d2028"; }}
          onMouseLeave={e => { if (!isHot) e.currentTarget.style.background = "#191b20"; }}>
          
          {/* Drag handle */}
          <div style={{ ...cellStyle({ padding: 0 }), cursor: "grab" }}>
            <DragGrip style={{ fontSize: 9 }} />
          </div>

          <div style={cellStyle()}>
            <ChatBubble count={(sub.updates || []).length} onClick={() => onOpenUpdates(task.id, sub.id)} />
          </div>
          <div style={{ ...cellStyle({ justifyContent: "flex-start", paddingLeft: 16, gap: 5 }) }}>
            <span title={isHot ? "Alterado agora — clique na linha para dispensar" : undefined} style={{ color: isHot ? "#fdab3d" : "#444", fontSize: isHot ? 10 : 8 }}>●</span>
            <EditText value={sub.name} onChange={v => upSub(task.id, sub.id, { ...sub, name: v })} style={{ color: "#b8bcc4", fontSize: 12.5 }} />
          </div>
          {visibleAllCols.map(col => <div key={col.id} style={cellStyle()}><CellRenderer col={col} item={sub} onChange={ns => upSub(task.id, sub.id, ns)} allPeople={allPeople} small /></div>)}
          {taskSubColumns.map(sc => <div key={sc.id} style={cellStyle()}><CellRenderer col={sc} item={sub} onChange={ns => upSub(task.id, sub.id, ns)} allPeople={allPeople} small subColumns={taskSubColumns} taskColumns={allCols} /></div>)}
          {perms.addColumns ? (
            <div onClick={() => { if (setActiveSubColTaskId) setActiveSubColTaskId(task.id); setShowAddSubCol(true); }} style={{ ...cellStyle({ borderRight: "none", cursor: "pointer", color: "#579bfc", fontSize: 13, fontWeight: 700, opacity: 0.4 }) }}
              onMouseEnter={e => e.currentTarget.style.opacity = 1} onMouseLeave={e => e.currentTarget.style.opacity = 0.4}>+</div>
          ) : <div style={{ ...cellStyle({ borderRight: "none" }) }} />}
        </div>
        );
      })}

      {/* Inline add subitem row */}
      <InlineAddRow placeholder="Adicionar subitem" gridCols={subGridCols} cellBorder={cellBorder} cellStyle={cellStyle} accentColor="#444" indent
        onAdd={(name) => {
          const newSub = { id: "s" + Date.now(), name, owner: "", status: "Não iniciado", priority: "Média", responsible: [], total: 0, cancellations: 0, deadline: null, custom: {}, updates: [] };
          if (apiAddSubitem) apiAddSubitem(task.id, newSub);
        }} />
    </div>
  );
}

// ─── KANBAN VIEW ─────────────────────────────────────────────────────────────
function KanbanView({ tasks, setTasks, apiUpdateTask, search, allPeople, onOpenUpdates, highlights = {}, onClearHighlight = () => {} }) {
  const filtered = useMemo(() => { const base = !search ? tasks : (() => { const q = search.toLowerCase(); return tasks.filter(t => t.name.toLowerCase().includes(q) || (t.responsible||[]).some(r => r.toLowerCase().includes(q))); })(); return sortByPriority(base); }, [tasks, search]);
  // Dentro de cada coluna de status os cards também saem por prioridade.
  const cols = useMemo(() => { const c = {}; STATUSES.forEach(s => c[s] = []); filtered.forEach(t => { if (c[t.status]) c[t.status].push(t); }); return c; }, [filtered]);
  const up = (tid, p) => { if (apiUpdateTask) { apiUpdateTask(tid, (prev) => ({ ...prev, ...p })); } else { setTasks(prev => prev.map(t => t.id === tid ? { ...t, ...p } : t)); } };
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${STATUSES.length}, minmax(240px, 1fr))`, gap: 12, overflowX: "auto", paddingBottom: 16 }}>
      {STATUSES.map(status => { const sc = STATUS_COLORS[status]; return (
        <div key={status} style={{ background: "#1a1d23", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ background: sc.bg, padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}><span style={{ color: sc.text, fontWeight: 700, fontSize: 13 }}>{status}</span><span style={{ color: sc.text, opacity: 0.7, fontSize: 11, fontWeight: 600, background: "rgba(0,0,0,.15)", padding: "2px 7px", borderRadius: 10 }}>{cols[status].length}</span></div>
          <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 6, minHeight: 180 }}>
            {cols[status].map(task => { const days = daysUntil(task.deadline); const dc = task.subitems.filter(s => s.status === "Feito").length; const pr = task.subitems.length > 0 ? (dc / task.subitems.length) * 100 : 0;
              // O card representa a tarefa inteira: alteração em qualquer subitem também o destaca.
              const hotKeys = [`t:${task.id}`, ...task.subitems.map(s => `s:${s.id}`)].filter(k => highlights[k]);
              const isHot = hotKeys.length > 0;
              return (
              <div key={task.id}
                onClick={() => hotKeys.forEach(onClearHighlight)}
                style={{ background: isHot ? HOT_BG : "#23262e", borderRadius: 8, padding: 12, borderLeft: `3px solid ${PRIORITY_COLORS[task.priority]?.bg || "#555"}`, transition: "all .15s", ...(isHot ? HOT_ROW : null) }}
                onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-2px)"; if (!isHot) e.currentTarget.style.boxShadow = "0 4px 12px rgba(0,0,0,.3)"; }}
                onMouseLeave={e => { e.currentTarget.style.transform = "none"; if (!isHot) e.currentTarget.style.boxShadow = "none"; }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                  <span style={{ fontWeight: 600, color: "#e8eaed", fontSize: 12 }}>{isHot && <span title="Alterado agora" style={{ color: "#fdab3d", marginRight: 5 }}>●</span>}{task.name}</span>
                  <ChatBubble count={(task.updates || []).length} onClick={() => onOpenUpdates(task.id)} />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}><PeoplePicker selected={task.responsible || []} onChange={r => up(task.id, { responsible: r })} allPeople={allPeople} /><PriorityBadge priority={task.priority} onClick={() => up(task.id, { priority: cyclePriority(task.priority) })} /></div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}><div style={{ flex: 1, height: 3, background: "#333", borderRadius: 2 }}><div style={{ width: `${pr}%`, height: "100%", background: "#00c875", borderRadius: 2 }} /></div><span style={{ fontSize: 10, color: "#778ca3" }}>{dc}/{task.subitems.length}</span></div>
                {task.deadline && <div style={{ fontSize: 10, color: days < 0 ? "#e2445c" : days <= 2 ? "#fdab3d" : "#778ca3", marginBottom: 6 }}>📅 {formatDate(task.deadline)}</div>}
                <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>{STATUSES.filter(s => s !== status).map(s => (<button key={s} onClick={() => up(task.id, { status: s })} style={{ background: STATUS_COLORS[s].bg, color: STATUS_COLORS[s].text, border: "none", borderRadius: 3, padding: "2px 6px", fontSize: 9, fontWeight: 600, cursor: "pointer", opacity: 0.7 }} onMouseEnter={e => e.target.style.opacity = 1} onMouseLeave={e => e.target.style.opacity = 0.7}>→ {s}</button>))}</div>
              </div>); })}
          </div>
        </div>); })}
    </div>
  );
}

// ─── TIMELINE VIEW ───────────────────────────────────────────────────────────
function TimelineView({ tasks, search }) {
  const allDates = useMemo(() => { const d = []; tasks.forEach(t => { if (t.deadline) d.push(new Date(t.deadline)); t.subitems.forEach(s => { if (s.deadline) d.push(new Date(s.deadline)); }); }); if (!d.length) { d.push(new Date()); const e = new Date(); e.setMonth(e.getMonth() + 6); d.push(e); } return d; }, [tasks]);
  const minD = useMemo(() => { const d = new Date(Math.min(...allDates)); d.setDate(1); return d; }, [allDates]);
  const maxD = useMemo(() => { const d = new Date(Math.max(...allDates)); d.setMonth(d.getMonth() + 1); d.setDate(0); return d; }, [allDates]);
  const totalDays = Math.max(1, Math.ceil((maxD - minD) / 86400000));
  const months = useMemo(() => { const m = [], cur = new Date(minD); while (cur <= maxD) { const s = new Date(cur), e = new Date(cur.getFullYear(), cur.getMonth() + 1, 0); const sd = Math.ceil((s - minD) / 86400000), ed = Math.min(totalDays, Math.ceil((e - minD) / 86400000)); m.push({ label: s.toLocaleDateString("pt-BR", { month: "short", year: "numeric" }), width: ((ed - sd) / totalDays) * 100 }); cur.setMonth(cur.getMonth() + 1); } return m; }, [minD, maxD, totalDays]);
  const getPos = (d) => d ? ((new Date(d) - minD) / 86400000 / totalDays) * 100 : null;
  const todayPos = getPos(new Date().toISOString().split("T")[0]);
  const filtered = useMemo(() => { if (!search) return tasks; const q = search.toLowerCase(); return tasks.filter(t => t.name.toLowerCase().includes(q)); }, [tasks, search]);
  const items = useMemo(() => { const r = []; filtered.forEach(t => { r.push({ type: "task", data: t }); t.subitems.filter(s => s.deadline).forEach(s => r.push({ type: "sub", data: s })); }); return r; }, [filtered]);
  return (
    <div style={{ overflowX: "auto" }}><div style={{ minWidth: 1000 }}>
      <div style={{ display: "flex", marginLeft: 260, marginBottom: 4, position: "sticky", top: 0, zIndex: 5, background: "#13151a" }}>{months.map((m, i) => <div key={i} style={{ width: `${m.width}%`, padding: "8px 4px", fontSize: 11, fontWeight: 700, color: "#778ca3", textTransform: "capitalize", textAlign: "center", borderBottom: "2px solid #2a2d35" }}>{m.label}</div>)}</div>
      {items.map((item, idx) => { const pos = getPos(item.data.deadline); const sc = STATUS_COLORS[item.data.status] || STATUS_COLORS["Não iniciado"]; const isT = item.type === "task"; return (
        <div key={idx} style={{ display: "flex", alignItems: "center", height: isT ? 40 : 28, borderBottom: "1px solid #1e2028" }}>
          <div style={{ width: 260, flexShrink: 0, padding: isT ? "0 10px" : "0 10px 0 30px", display: "flex", alignItems: "center", gap: 6, overflow: "hidden" }}>{!isT && <span style={{ color: "#444", fontSize: 8 }}>●</span>}<span style={{ fontSize: isT ? 12 : 10, fontWeight: isT ? 600 : 400, color: isT ? "#e8eaed" : "#a5b1c2", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.data.name}</span></div>
          <div style={{ flex: 1, position: "relative", height: "100%" }}>{todayPos !== null && <div style={{ position: "absolute", left: `${todayPos}%`, top: 0, bottom: 0, width: 2, background: "#e2445c", zIndex: 3, opacity: 0.5 }} />}{pos !== null && <div style={{ position: "absolute", left: `${Math.max(0, pos - 4)}%`, top: "50%", transform: "translateY(-50%)", zIndex: 2 }}><div style={{ width: isT ? 120 : 80, height: isT ? 22 : 16, background: sc.bg, borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 6px rgba(0,0,0,.3)" }}><span style={{ color: sc.text, fontSize: isT ? 10 : 9, fontWeight: 600 }}>{formatDate(item.data.deadline)}</span></div></div>}</div>
        </div>); })}
    </div></div>
  );
}

// ─── AI PANEL ────────────────────────────────────────────────────────────────
function AIPanel({ tasks, automations, setAutomations, canManageAutomations, columns, subColumns, users, onDataChanged }) {
  const [activeTab, setActiveTab] = useState("analysis");
  const [loading, setLoading] = useState(false);
  const [analysis, setAnalysis] = useState(null);
  const [aiChat, setAiChat] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [showCreateAuto, setShowCreateAuto] = useState(false);
  const [autoMode, setAutoMode] = useState("guided"); // "guided" (formato pré-definido) | "free" (texto + IA)
  const [autoDesc, setAutoDesc] = useState("");
  const [autoName, setAutoName] = useState("");
  const [autoParsing, setAutoParsing] = useState(false);
  const [autoError, setAutoError] = useState("");
  const [runningId, setRunningId] = useState(null);
  const [runToast, setRunToast] = useState(null);

  // ─── Formato guiado (notify): "Quando [tarefa/subitem] atingir [data] → notificar [mensagem] [pessoa]"
  // Datas/prazos já estabelecidos em tarefas/subitens (deadline + colunas de data), para o 2º dropdown.
  const knownDates = useMemo(() => {
    const set = new Set();
    const dateCols = (columns || []).filter(c => c.type === "date");
    const subDateCols = (subColumns || []).filter(c => c.type === "date");
    for (const t of (tasks || [])) {
      if (t.deadline) set.add(t.deadline);
      for (const c of dateCols) { const v = (t.custom || {})[c.id]; if (v) set.add(v); }
      for (const s of (t.subitems || [])) {
        if (s.deadline) set.add(s.deadline);
        for (const c of subDateCols) { const v = (s.custom || {})[c.id]; if (v) set.add(v); }
      }
    }
    return [...set].sort();
  }, [tasks, columns, subColumns]);

  const [gTaskId, setGTaskId] = useState("");
  const [gSubId, setGSubId] = useState("");        // "" = a tarefa em si; senão id do subitem
  const [gDateSel, setGDateSel] = useState("");    // uma data conhecida, ou "__custom__"
  const [gCustomDate, setGCustomDate] = useState("");
  const [gMessage, setGMessage] = useState("");
  const [gRecipients, setGRecipients] = useState([]);

  const selectedTask = (tasks || []).find(t => t.id === gTaskId) || null;
  const subitemsOfTask = selectedTask?.subitems || [];

  // Cada item tem uma única data (o prazo): ao escolher tarefa/subitem, preenche a data automaticamente.
  useEffect(() => {
    if (!showCreateAuto || autoMode !== "guided") return;
    const item = gSubId ? subitemsOfTask.find(s => s.id === gSubId) : selectedTask;
    setGDateSel(item?.deadline || "");
    if (!item?.deadline) setGCustomDate("");
  }, [gTaskId, gSubId, showCreateAuto, autoMode]);

  const openCreateAuto = () => {
    setShowCreateAuto(true); setAutoError(""); setAutoMode("guided");
    setGTaskId((tasks || [])[0]?.id || ""); setGSubId("");
    setGDateSel(""); setGCustomDate("");
    setGMessage(""); setGRecipients([]);
    setAutoDesc(""); setAutoName("");
  };
  const onPickTask = (taskId) => { setGTaskId(taskId); setGSubId(""); };  // troca de tarefa zera o subitem
  const toggleRecipient = (name) =>
    setGRecipients(prev => prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]);

  const rawFetch = async (path, opts) => {
    const token = localStorage.getItem("rotina_token");
    const res = await fetch(`${API_URL}/api${path}`, { ...opts, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(opts?.headers || {}) } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  };

  const createAutomation = async () => {
    let body;
    if (autoMode === "guided") {
      if (!gTaskId) { setAutoError("Selecione a tarefa"); return; }
      const date = gDateSel === "__custom__" ? gCustomDate : gDateSel;
      if (!date) { setAutoError("Selecione a data (prazo) ou escolha uma data personalizada"); return; }
      if (!gMessage.trim()) { setAutoError("Escreva a mensagem da notificação"); return; }
      if (gRecipients.length === 0) { setAutoError("Selecione ao menos uma pessoa para notificar"); return; }
      const targetType = gSubId ? "subitem" : "task";
      const targetId = gSubId || gTaskId;
      const rule = {
        type: "notify",
        mode: "specific",
        targetType,
        targetId,
        date,
        recipients: gRecipients,
        message: gMessage.trim(),
      };
      const subName = subitemsOfTask.find(s => s.id === gSubId)?.name;
      const targetLabel = gSubId ? `${selectedTask?.name || "?"} › ${subName || "?"}` : (selectedTask?.name || "?");
      const typeLabel = targetType === "task" ? "tarefa" : "subitem";
      const description = `Quando a/o ${typeLabel} "${targetLabel}" atingir ${formatDate(date)}, notificar ${gRecipients.join(", ")}: "${gMessage.trim()}"`;
      body = { rule, description, name: autoName.trim() || undefined };
    } else {
      if (!autoDesc.trim()) { setAutoError("Descreva a automação"); return; }
      body = { description: autoDesc.trim(), name: autoName.trim() || undefined };
    }
    setAutoParsing(true); setAutoError("");
    try {
      const result = await rawFetch("/automations", { method: "POST", body: JSON.stringify(body) });
      setAutomations(prev => [...prev, result]);
      setShowCreateAuto(false); setAutoDesc(""); setAutoName("");
    } catch (e) {
      setAutoError(e.message);
    } finally {
      setAutoParsing(false);
    }
  };

  const testGemini = async () => {
    setAutoError(""); setAutoParsing(true);
    try {
      const r = await rawFetch("/admin/gemini-health");
      let q = "";
      if (r.quota) {
        const parts = [`${r.quota.rpm}/${r.quota.rpmLimit} por min`, `${r.quota.rpd}/${r.quota.rpdLimit} por dia`];
        if (r.quota.dailyCooldownMinLeft) parts.push(`⏳ diário em ${r.quota.dailyCooldownMinLeft} min`);
        if (r.quota.minuteCooldownSecLeft) parts.push(`⏳ minuto em ${r.quota.minuteCooldownSecLeft}s`);
        q = ` [${parts.join(" · ")}]`;
      }
      if (r.ok) setAutoError(`✅ Gemini OK (modelo: ${r.model}). Resposta teste: ${r.response}${q}`);
      else setAutoError(`❌ Gemini com problema: ${r.error}${q}`);
    } catch (e) {
      setAutoError(`❌ Falha ao testar: ${e.message}`);
    } finally {
      setAutoParsing(false);
    }
  };

  const runAutomation = async (id) => {
    setRunningId(id); setRunToast(null);
    try {
      const result = await rawFetch(`/automations/${id}/run`, { method: "POST" });
      setRunToast({ ok: true, msg: result.summary || `${result.applied} linhas atualizadas` });
      if (onDataChanged) await onDataChanged();
    } catch (e) {
      setRunToast({ ok: false, msg: e.message });
    } finally {
      setRunningId(null);
      setTimeout(() => setRunToast(null), 6000);
    }
  };

  const deleteAutomation = async (id) => {
    if (!window.confirm("Excluir esta automação?")) return;
    const result = await apiCall(`/automations/${id}`, { method: "DELETE" });
    if (result) setAutomations(prev => prev.filter(a => a.id !== id));
  };

  // ─── DEEP ANALYSIS ─────────────────────────────────────────────────────────
  const runAnalysis = () => {
    setLoading(true);
    setTimeout(() => {
      const now = new Date(); now.setHours(0,0,0,0);
      const errors = [];
      const conflicts = [];
      const improvements = [];
      const stats = { total: tasks.length, totalSubs: 0, done: 0, overdue: 0, stopped: 0, noResp: 0, noPriority: 0, noDeadline: 0, emptyTasks: 0 };

      tasks.forEach(t => {
        const subs = t.subitems || [];
        stats.totalSubs += subs.length;
        stats.done += subs.filter(s => s.status === "Feito").length;
        if (t.status === "Parado") stats.stopped++;

        // Errors
        if (!t.name || t.name.trim() === "") errors.push({ type: "error", icon: "🔴", msg: `Tarefa sem nome (ID: ${t.id})` });
        if (subs.length === 0) { stats.emptyTasks++; errors.push({ type: "warning", icon: "🟡", msg: `"${t.name}" não tem subitens` }); }
        if ((!t.responsible || t.responsible.length === 0)) { stats.noResp++; errors.push({ type: "warning", icon: "🟡", msg: `"${t.name}" sem responsável atribuído` }); }
        if (!t.deadline) { stats.noDeadline++; }

        // Overdue
        if (t.deadline) {
          const dl = parseLocalDate(t.deadline); if (dl) { dl.setHours(0,0,0,0); if (dl < now) { stats.overdue++; errors.push({ type: "error", icon: "🔴", msg: `"${t.name}" está atrasada (prazo: ${formatDate(t.deadline)})` }); } }
        }

        // Conflicts
        subs.forEach(s => {
          if (s.status === "Feito" && t.status === "Não iniciado") conflicts.push({ icon: "⚠️", msg: `Subitem "${s.name}" está feito, mas tarefa "${t.name}" está como "Não iniciado"` });
          if (s.status === "Parado") conflicts.push({ icon: "🛑", msg: `Subitem "${s.name}" em "${t.name}" está parado — pode estar bloqueando progresso` });
        });

        // Check duplicate names
        const subNames = subs.map(s => s.name.toLowerCase());
        const dupes = subNames.filter((n, i) => subNames.indexOf(n) !== i);
        if (dupes.length > 0) conflicts.push({ icon: "📋", msg: `Subitens duplicados em "${t.name}": ${[...new Set(dupes)].join(", ")}` });
      });

      // Improvements
      if (stats.noDeadline > 0) improvements.push({ icon: "📅", msg: `${stats.noDeadline} tarefa(s) sem prazo definido — defina prazos para melhor controle` });
      if (stats.emptyTasks > 0) improvements.push({ icon: "📝", msg: `${stats.emptyTasks} tarefa(s) sem subitens — quebre em etapas menores` });
      if (stats.stopped > 0) improvements.push({ icon: "🔄", msg: `${stats.stopped} tarefa(s) parada(s) — revise bloqueios e redistribua` });
      if (stats.noResp > 0) improvements.push({ icon: "👥", msg: `${stats.noResp} tarefa(s) sem responsável — atribua para garantir execução` });
      const progress = stats.totalSubs > 0 ? Math.round(stats.done / stats.totalSubs * 100) : 0;
      if (progress < 50) improvements.push({ icon: "📈", msg: `Progresso geral em ${progress}% — foque nas tarefas de alta prioridade` });
      if (progress >= 80) improvements.push({ icon: "🎉", msg: `Excelente! ${progress}% concluído — mantenha o ritmo!` });

      setAnalysis({ errors, conflicts, improvements, stats, progress, timestamp: new Date().toISOString() });
      setLoading(false);
    }, 800);
  };

  // ─── AI CHAT (Simulated consultant) ────────────────────────────────────────
  const sendChat = () => {
    if (!chatInput.trim()) return;
    const userMsg = chatInput.trim();
    setAiChat(prev => [...prev, { role: "user", text: userMsg }]);
    setChatInput(""); setChatLoading(true);

    setTimeout(() => {
      // Smart context-aware responses
      const lower = userMsg.toLowerCase();
      let response = "";
      const ov = tasks.filter(t => t.deadline && daysUntil(t.deadline) < 0);
      const stopped = tasks.filter(t => t.status === "Parado");
      const totalSubs = tasks.reduce((a, t) => a + t.subitems.length, 0);
      const doneSubs = tasks.reduce((a, t) => a + t.subitems.filter(s => s.status === "Feito").length, 0);

      if (lower.includes("atras") || lower.includes("prazo")) {
        response = ov.length > 0 ? `Encontrei ${ov.length} tarefa(s) atrasada(s):\n${ov.map(t => `• "${t.name}" — prazo era ${formatDate(t.deadline)}`).join("\n")}\n\nRecomendo revisar os prazos e redistribuir responsáveis.` : "Nenhuma tarefa atrasada no momento. Tudo dentro do prazo!";
      } else if (lower.includes("parad") || lower.includes("bloque")) {
        response = stopped.length > 0 ? `${stopped.length} tarefa(s) parada(s):\n${stopped.map(t => `• "${t.name}"`).join("\n")}\n\nSugestão: Identifique o que está bloqueando cada uma e considere redistribuir para outro responsável.` : "Nenhuma tarefa parada. Tudo em andamento!";
      } else if (lower.includes("progresso") || lower.includes("status") || lower.includes("resumo")) {
        const pct = totalSubs > 0 ? Math.round(doneSubs / totalSubs * 100) : 0;
        response = `📊 Resumo geral:\n• ${tasks.length} tarefas, ${totalSubs} subitens\n• ${doneSubs} concluídos (${pct}%)\n• ${ov.length} atrasada(s)\n• ${stopped.length} parada(s)\n\n${pct >= 70 ? "Bom progresso! Foque nos itens parados." : "Progresso pode melhorar. Priorize as tarefas críticas."}`;
      } else if (lower.includes("priorida") || lower.includes("urgent") || lower.includes("critic")) {
        const critical = tasks.filter(t => t.priority === "Crítica" || t.priority === "Alta");
        response = critical.length > 0 ? `${critical.length} tarefa(s) de alta prioridade:\n${critical.map(t => `• "${t.name}" [${t.priority}] — ${t.status}`).join("\n")}\n\nFoque nessas primeiro.` : "Nenhuma tarefa com prioridade crítica/alta.";
      } else if (lower.includes("melhor") || lower.includes("sugest") || lower.includes("dica")) {
        response = "Sugestões de melhoria:\n\n1. Defina prazos para todas as tarefas\n2. Atribua responsáveis a cada tarefa\n3. Quebre tarefas grandes em subitens menores\n4. Revise tarefas paradas semanalmente\n5. Use relatórios para documentar progresso\n6. Mantenha os status atualizados diariamente";
      } else {
        response = `Entendi sua pergunta sobre "${userMsg}". Posso ajudar com:\n\n• "Quais tarefas estão atrasadas?"\n• "Mostre o progresso geral"\n• "Quais tarefas estão paradas?"\n• "Quais são prioridade alta?"\n• "Dê sugestões de melhoria"\n\nDigite uma dessas perguntas ou algo relacionado às suas tarefas.`;
      }

      setAiChat(prev => [...prev, { role: "ai", text: response }]);
      setChatLoading(false);
    }, 1000);
  };

  const tabs = [
    { key: "analysis", label: "Análise", icon: "🔍" },
    { key: "chat", label: "Consultor", icon: "💬" },
    { key: "auto", label: "Automações", icon: "⚡" },
  ];

  return (
    <div>
      {/* Tabs */}
      <div style={{ display: "flex", marginBottom: 12, background: "#13151a", borderRadius: 8, overflow: "hidden", border: "1px solid #2a2d35" }}>
        {tabs.map(t => (
          <button key={t.key} onClick={() => setActiveTab(t.key)} style={{ flex: 1, padding: "8px 4px", border: "none", cursor: "pointer", fontSize: 11, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 3, background: activeTab === t.key ? "#6c5ce7" : "transparent", color: activeTab === t.key ? "#fff" : "#778ca3" }}>
            <span style={{ fontSize: 12 }}>{t.icon}</span> {t.label}
          </button>
        ))}
      </div>

      {/* ANALYSIS TAB */}
      {activeTab === "analysis" && (
        <div>
          <div style={{ background: "linear-gradient(135deg, #1a1040 0%, #0d2137 100%)", borderRadius: 12, padding: 14, marginBottom: 12, border: "1px solid #2a1f5e" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 20 }}>🧠</span>
              <div><div style={{ fontWeight: 700, fontSize: 13 }}>Diagnóstico do Quadro</div><div style={{ fontSize: 10, color: "#778ca3" }}>Erros, conflitos e melhorias</div></div>
            </div>
            <button onClick={runAnalysis} disabled={loading} style={{ background: loading ? "#333" : "linear-gradient(135deg, #6c5ce7, #a55eea)", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 12, fontWeight: 600, cursor: loading ? "wait" : "pointer", width: "100%" }}>
              {loading ? "⏳ Analisando..." : "🔍 Executar Diagnóstico"}
            </button>
          </div>

          {analysis && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {/* Stats bar */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
                {[{ l: "Progresso", v: analysis.progress + "%", c: analysis.progress >= 70 ? "#00c875" : "#fdab3d" }, { l: "Atrasadas", v: analysis.stats.overdue, c: analysis.stats.overdue > 0 ? "#e2445c" : "#00c875" }, { l: "Paradas", v: analysis.stats.stopped, c: analysis.stats.stopped > 0 ? "#fdab3d" : "#00c875" }].map((s, i) => (
                  <div key={i} style={{ background: "#23262e", borderRadius: 8, padding: "8px 6px", textAlign: "center", border: "1px solid #333" }}>
                    <div style={{ fontSize: 16, fontWeight: 800, color: s.c }}>{s.v}</div>
                    <div style={{ fontSize: 9, color: "#778ca3", fontWeight: 600 }}>{s.l}</div>
                  </div>
                ))}
              </div>

              {/* Errors */}
              {analysis.errors.length > 0 && (
                <div style={{ background: "#2a1a1a", borderRadius: 8, padding: 10, border: "1px solid #4a2020" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#e2445c", marginBottom: 6 }}>🔴 Erros e Alertas ({analysis.errors.length})</div>
                  {analysis.errors.slice(0, 5).map((e, i) => <div key={i} style={{ fontSize: 11, color: "#d4a0a0", padding: "3px 0", lineHeight: 1.5 }}>{e.icon} {e.msg}</div>)}
                  {analysis.errors.length > 5 && <div style={{ fontSize: 10, color: "#666", marginTop: 4 }}>+{analysis.errors.length - 5} mais...</div>}
                </div>
              )}

              {/* Conflicts */}
              {analysis.conflicts.length > 0 && (
                <div style={{ background: "#2a2510", borderRadius: 8, padding: 10, border: "1px solid #4a4020" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#fdab3d", marginBottom: 6 }}>⚠️ Conflitos ({analysis.conflicts.length})</div>
                  {analysis.conflicts.slice(0, 5).map((c, i) => <div key={i} style={{ fontSize: 11, color: "#c4b080", padding: "3px 0", lineHeight: 1.5 }}>{c.icon} {c.msg}</div>)}
                  {analysis.conflicts.length > 5 && <div style={{ fontSize: 10, color: "#666", marginTop: 4 }}>+{analysis.conflicts.length - 5} mais...</div>}
                </div>
              )}

              {/* Improvements */}
              {analysis.improvements.length > 0 && (
                <div style={{ background: "#102a1a", borderRadius: 8, padding: 10, border: "1px solid #204a30" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#00c875", marginBottom: 6 }}>💡 Melhorias Sugeridas ({analysis.improvements.length})</div>
                  {analysis.improvements.map((m, i) => <div key={i} style={{ fontSize: 11, color: "#90c4a0", padding: "3px 0", lineHeight: 1.5 }}>{m.icon} {m.msg}</div>)}
                </div>
              )}

              {analysis.errors.length === 0 && analysis.conflicts.length === 0 && (
                <div style={{ background: "#102a1a", borderRadius: 8, padding: 14, textAlign: "center", border: "1px solid #204a30" }}>
                  <span style={{ fontSize: 24 }}>✅</span>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#00c875", marginTop: 4 }}>Quadro saudável! Nenhum erro ou conflito encontrado.</div>
                </div>
              )}

              <div style={{ fontSize: 9, color: "#444", textAlign: "right" }}>Última análise: {formatTime(analysis.timestamp)}</div>
            </div>
          )}
        </div>
      )}

      {/* CHAT TAB */}
      {activeTab === "chat" && (
        <div style={{ display: "flex", flexDirection: "column", height: 400 }}>
          <div style={{ background: "linear-gradient(135deg, #1a1040 0%, #0d2137 100%)", borderRadius: 10, padding: 12, marginBottom: 8, border: "1px solid #2a1f5e" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 20 }}>🤖</span>
              <div><div style={{ fontWeight: 700, fontSize: 13 }}>Consultor IA</div><div style={{ fontSize: 10, color: "#778ca3" }}>Pergunte sobre suas tarefas</div></div>
            </div>
          </div>
          <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column", gap: 8, marginBottom: 8 }}>
            {aiChat.length === 0 && (
              <div style={{ textAlign: "center", padding: "20px 10px", color: "#556" }}>
                <div style={{ fontSize: 28, marginBottom: 6 }}>💬</div>
                <div style={{ fontSize: 12, color: "#778ca3" }}>Pergunte algo sobre suas tarefas</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 10 }}>
                  {["Quais tarefas estão atrasadas?", "Mostre o progresso geral", "Dê sugestões de melhoria"].map((q, i) => (
                    <div key={i} onClick={() => { setChatInput(q); }} style={{ background: "#23262e", borderRadius: 6, padding: "6px 10px", fontSize: 11, color: "#579bfc", cursor: "pointer", border: "1px solid #333" }}
                      onMouseEnter={e => e.currentTarget.style.background = "#2a2d35"} onMouseLeave={e => e.currentTarget.style.background = "#23262e"}>
                      {q}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {aiChat.map((msg, i) => (
              <div key={i} style={{ display: "flex", justifyContent: msg.role === "user" ? "flex-end" : "flex-start" }}>
                <div style={{ maxWidth: "85%", background: msg.role === "user" ? "#6c5ce7" : "#23262e", borderRadius: 10, padding: "8px 12px", border: msg.role === "ai" ? "1px solid #333" : "none" }}>
                  {msg.role === "ai" && <div style={{ fontSize: 9, color: "#6c5ce7", fontWeight: 600, marginBottom: 4 }}>🤖 Consultor IA</div>}
                  <div style={{ fontSize: 12, color: "#e8eaed", lineHeight: 1.6, whiteSpace: "pre-line" }}>{msg.text}</div>
                </div>
              </div>
            ))}
            {chatLoading && <div style={{ display: "flex", gap: 4, padding: "8px 12px" }}><div style={{ width: 6, height: 6, borderRadius: "50%", background: "#6c5ce7", animation: "pulse 1s ease infinite" }} /><div style={{ width: 6, height: 6, borderRadius: "50%", background: "#6c5ce7", animation: "pulse 1s ease infinite .2s" }} /><div style={{ width: 6, height: 6, borderRadius: "50%", background: "#6c5ce7", animation: "pulse 1s ease infinite .4s" }} /></div>}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input value={chatInput} onChange={e => setChatInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") sendChat(); }}
              placeholder="Pergunte algo..." style={{ flex: 1, padding: "8px 10px", borderRadius: 8, border: "1px solid #333", background: "#13151a", color: "#e8eaed", fontSize: 12, outline: "none" }} />
            <button onClick={sendChat} disabled={chatLoading} style={{ background: "#6c5ce7", color: "#fff", border: "none", borderRadius: 8, padding: "8px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>→</button>
          </div>
        </div>
      )}

      {/* AUTOMATIONS TAB */}
      {activeTab === "auto" && (
        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>⚡ Automações IA</div>
            {canManageAutomations && (
              <button onClick={openCreateAuto} style={{ background: "linear-gradient(135deg, #6c5ce7, #a55eea)", color: "#fff", border: "none", borderRadius: 6, padding: "5px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>+ Nova</button>
            )}
          </div>

          {runToast && (
            <div style={{ background: runToast.ok ? "#102a1a" : "#2a1a1a", border: `1px solid ${runToast.ok ? "#204a30" : "#4a2020"}`, color: runToast.ok ? "#00c875" : "#e2445c", borderRadius: 8, padding: 8, fontSize: 11, marginBottom: 8 }}>
              {runToast.ok ? "✅ " : "❌ "}{runToast.msg}
            </div>
          )}

          {automations.map(a => {
            const isUser = !a.builtIn && a.ruleConfig;
            const canRun = !!a.ruleConfig;
            return (
              <div key={a.id} style={{ background: "#23262e", borderRadius: 8, padding: 10, display: "flex", alignItems: "center", gap: 8, border: a.active ? "1px solid #6c5ce7" : "1px solid #333", marginBottom: 6 }}>
                <span style={{ fontSize: 18 }}>{a.icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</div>
                  <div style={{ fontSize: 10, color: "#778ca3", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{isUser ? (a.naturalPrompt || a.desc) : a.desc}</div>
                  {isUser && a.lastRunAt && <div style={{ fontSize: 9, color: "#556", marginTop: 2 }}>Última execução: {a.lastRunStatus || "—"}</div>}
                </div>
                {canRun && canManageAutomations && (
                  <button onClick={() => runAutomation(a.id)} disabled={runningId === a.id} title="Executar" style={{ background: runningId === a.id ? "#444" : "#00c875", color: "#fff", border: "none", borderRadius: 6, padding: "4px 8px", fontSize: 11, fontWeight: 700, cursor: runningId === a.id ? "wait" : "pointer" }}>
                    {runningId === a.id ? "⏳" : "▶"}
                  </button>
                )}
                {isUser && canManageAutomations && (
                  <button onClick={() => deleteAutomation(a.id)} title="Excluir" style={{ background: "transparent", color: "#e2445c", border: "1px solid #4a2020", borderRadius: 6, padding: "4px 6px", fontSize: 11, cursor: "pointer" }}>🗑</button>
                )}
                {canManageAutomations ? (
                  <div onClick={() => setAutomations(p => p.map(x => x.id === a.id ? { ...x, active: !x.active } : x))} style={{ width: 36, height: 20, borderRadius: 10, background: a.active ? "#6c5ce7" : "#444", cursor: "pointer", position: "relative" }}><div style={{ width: 16, height: 16, borderRadius: "50%", background: "#fff", position: "absolute", top: 2, left: a.active ? 18 : 2, transition: "left .2s" }} /></div>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <div style={{ width: 36, height: 20, borderRadius: 10, background: a.active ? "#6c5ce740" : "#33333380", position: "relative", opacity: 0.5 }}><div style={{ width: 16, height: 16, borderRadius: "50%", background: "#aaa", position: "absolute", top: 2, left: a.active ? 18 : 2 }} /></div>
                    <LockedOverlay />
                  </div>
                )}
              </div>
            );
          })}

          {showCreateAuto && (
            <div onClick={() => !autoParsing && setShowCreateAuto(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
              <div onClick={e => e.stopPropagation()} style={{ background: "#1a1d23", border: "1px solid #2a2d35", borderRadius: 12, padding: 20, width: 480, maxWidth: "90vw" }}>
                <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 10 }}>✨ Nova automação</div>

                {/* Seletor de modo */}
                <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
                  {[{ k: "guided", l: "📋 Formato guiado" }, { k: "free", l: "💬 Descrição livre (IA)" }].map(m => (
                    <button key={m.k} onClick={() => { setAutoMode(m.k); setAutoError(""); }} style={{ flex: 1, padding: "7px 8px", borderRadius: 7, border: `1px solid ${autoMode === m.k ? "#6c5ce7" : "#333"}`, background: autoMode === m.k ? "#6c5ce722" : "#13151a", color: autoMode === m.k ? "#cbb9ff" : "#778ca3", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>{m.l}</button>
                  ))}
                </div>

                <input value={autoName} onChange={e => setAutoName(e.target.value)} placeholder="Nome (opcional)" style={{ width: "100%", padding: "8px 10px", borderRadius: 7, border: "1px solid #333", background: "#13151a", color: "#e8eaed", fontSize: 12, marginBottom: 12, boxSizing: "border-box" }} />

                {autoMode === "guided" ? (() => {
                  const fieldStyle = { width: "100%", padding: "8px 10px", borderRadius: 7, border: "1px solid #333", background: "#13151a", color: "#e8eaed", fontSize: 12, boxSizing: "border-box" };
                  const labelStyle = { fontSize: 11, fontWeight: 700, color: "#a55eea", marginBottom: 5, display: "block" };
                  const rowStyle = { marginBottom: 12 };
                  return (
                    <div>
                      <div style={{ fontSize: 11, color: "#778ca3", marginBottom: 14, lineHeight: 1.5 }}>
                        <b>Quando</b> a tarefa/subitem escolhida <b>atingir a data</b>, <b>notificar</b> a mensagem para as pessoas — no campo de mensagens do item.
                      </div>

                      <div style={rowStyle}>
                        <label style={labelStyle}>1. Quando (qual tarefa)?</label>
                        {(tasks || []).length === 0 ? (
                          <div style={{ fontSize: 11, color: "#e2445c" }}>Nenhuma tarefa cadastrada no quadro.</div>
                        ) : (
                          <select value={gTaskId} onChange={e => onPickTask(e.target.value)} style={{ ...fieldStyle, marginBottom: 6 }}>
                            {(tasks || []).map(t => <option key={t.id} value={t.id}>{t.name || "(tarefa sem nome)"}</option>)}
                          </select>
                        )}
                        <select value={gSubId} onChange={e => setGSubId(e.target.value)} style={fieldStyle} disabled={!gTaskId}>
                          <option value="">A tarefa inteira</option>
                          {subitemsOfTask.map(s => <option key={s.id} value={s.id}>Subitem: {s.name || "(sem nome)"}</option>)}
                        </select>
                      </div>

                      <div style={rowStyle}>
                        <label style={labelStyle}>2. Atingir qual data (prazo)?</label>
                        <select value={gDateSel} onChange={e => setGDateSel(e.target.value)} style={{ ...fieldStyle, marginBottom: gDateSel === "__custom__" ? 6 : 0 }}>
                          <option value="">— escolher —</option>
                          {knownDates.map(d => <option key={d} value={d}>{d} — {formatDate(d)} (prazo já existente)</option>)}
                          <option value="__custom__">📅 Outra data (escolher)…</option>
                        </select>
                        {gDateSel === "__custom__" && (
                          <input type="date" value={gCustomDate} onChange={e => setGCustomDate(e.target.value)} style={fieldStyle} />
                        )}
                        {(() => {
                          const dl = (gSubId ? subitemsOfTask.find(s => s.id === gSubId) : selectedTask)?.deadline;
                          return dl
                            ? <div style={{ fontSize: 10, color: "#00c875", marginTop: 4 }}>✓ Preenchido com o prazo do item ({formatDate(dl)}). Você pode alterar.</div>
                            : <div style={{ fontSize: 10, color: "#778ca3", marginTop: 4 }}>Este item não tem prazo definido — escolha uma data.</div>;
                        })()}
                      </div>

                      <div style={rowStyle}>
                        <label style={labelStyle}>3. Notificar qual mensagem?</label>
                        <textarea value={gMessage} onChange={e => setGMessage(e.target.value)} placeholder='Ex.: "Atualizar promoções"' rows={2} style={{ ...fieldStyle, resize: "vertical", fontFamily: "inherit" }} />
                      </div>

                      <div style={rowStyle}>
                        <label style={labelStyle}>4. Para quais pessoas?</label>
                        {(!users || users.length === 0) ? (
                          <div style={{ fontSize: 11, color: "#778ca3" }}>Nenhum usuário cadastrado.</div>
                        ) : (
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                            {users.map(u => {
                              const on = gRecipients.includes(u.name);
                              return (
                                <button key={u.id || u.name} onClick={() => toggleRecipient(u.name)} style={{ padding: "5px 10px", borderRadius: 14, border: `1px solid ${on ? "#00c875" : "#333"}`, background: on ? "#00c87522" : "#13151a", color: on ? "#00c875" : "#aab", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
                                  {on ? "✓ " : ""}{u.name}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })() : (
                  <textarea value={autoDesc} onChange={e => setAutoDesc(e.target.value)} placeholder={'Exemplos:\n• "Soma dos números das colunas de pedidos em cada linha dos subitem, mostrando o total na coluna TOTAL POR CANAL DE VENDA"\n• "Notificar @camila e @gabriela \'Atualizar promoções\' quando atingir a data de prazo de subitens de tarefas com nome DESCONTO"'} rows={6} style={{ width: "100%", padding: "8px 10px", borderRadius: 7, border: "1px solid #333", background: "#13151a", color: "#e8eaed", fontSize: 12, resize: "vertical", boxSizing: "border-box", fontFamily: "inherit" }} />
                )}
                {autoError && <div style={{ marginTop: 10, padding: 8, background: "#2a1a1a", border: "1px solid #4a2020", borderRadius: 6, color: "#e2445c", fontSize: 11 }}>❌ {autoError}</div>}
                <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center", marginTop: 14 }}>
                  {autoMode === "free" ? (
                    <button onClick={testGemini} disabled={autoParsing} title="Verifica se a API Gemini está configurada e respondendo" style={{ background: "transparent", color: "#579bfc", border: "1px solid #1a3a5e", borderRadius: 7, padding: "7px 10px", fontSize: 11, cursor: "pointer" }}>🔌 Testar Gemini</button>
                  ) : <span />}
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => setShowCreateAuto(false)} disabled={autoParsing} style={{ background: "transparent", color: "#778ca3", border: "1px solid #333", borderRadius: 7, padding: "7px 14px", fontSize: 12, cursor: "pointer" }}>Cancelar</button>
                    <button onClick={createAutomation} disabled={autoParsing} style={{ background: autoParsing ? "#444" : "linear-gradient(135deg, #6c5ce7, #a55eea)", color: "#fff", border: "none", borderRadius: 7, padding: "7px 14px", fontSize: 12, fontWeight: 700, cursor: autoParsing ? "wait" : "pointer" }}>{autoParsing ? (autoMode === "guided" ? "⏳ Criando..." : "⏳ Interpretando...") : "Criar"}</button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      <style>{`@keyframes pulse { 0%, 100% { opacity: 0.3; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.2); } }`}</style>
    </div>
  );
}

// ─── GOOGLE DRIVE SIMULATION ─────────────────────────────────────────────────
const DRIVE_ACCOUNT = { email: "diversemodas1997@gmail.com", name: "Diverse Modas", photo: "D" };

const INITIAL_DRIVE_FILES = [
  { id: "df1", name: "Planilha Pedidos Abril.xlsx", type: "xlsx", size: "2.4 MB", modified: "2026-04-07T14:30:00", folder: "Pedidos", shared: ["Gabriela", "Camila"] },
  { id: "df2", name: "Relatório Vendas Q1.pdf", type: "pdf", size: "1.8 MB", modified: "2026-04-05T09:15:00", folder: "Relatórios", shared: ["Gabriela"] },
  { id: "df3", name: "Fotos Estoque Moscow.zip", type: "zip", size: "45.2 MB", modified: "2026-04-06T16:45:00", folder: "Estoque", shared: [] },
  { id: "df4", name: "Etiquetas Shopee.pdf", type: "pdf", size: "890 KB", modified: "2026-04-07T08:00:00", folder: "Etiquetas", shared: ["Junior"] },
  { id: "df5", name: "Controle Financeiro 2026.xlsx", type: "xlsx", size: "5.1 MB", modified: "2026-04-04T11:20:00", folder: "Financeiro", shared: ["Gabriela", "Camila", "Ana"] },
  { id: "df6", name: "Logo Diverse.png", type: "png", size: "320 KB", modified: "2026-03-15T10:00:00", folder: "Marketing", shared: [] },
  { id: "df7", name: "Tabela Preços Hungria.xlsx", type: "xlsx", size: "1.2 MB", modified: "2026-04-07T13:00:00", folder: "Preços", shared: ["Camila"] },
  { id: "df8", name: "Contrato Fornecedor TikTok.docx", type: "docx", size: "456 KB", modified: "2026-04-01T14:00:00", folder: "Contratos", shared: ["Gabriela"] },
  { id: "df9", name: "Manual Operações.pdf", type: "pdf", size: "3.2 MB", modified: "2026-03-20T09:00:00", folder: "Documentos", shared: ["Gabriela", "Camila", "Junior"] },
  { id: "df10", name: "Backup Pedidos Março.csv", type: "csv", size: "12.8 MB", modified: "2026-04-01T23:59:00", folder: "Backups", shared: [] },
  { id: "df11", name: "Promoção FB Closet - Artes.psd", type: "psd", size: "28.5 MB", modified: "2026-04-06T17:30:00", folder: "Marketing", shared: ["Lucas"] },
  { id: "df12", name: "Rotina Escritório - Monday.xlsx", type: "xlsx", size: "340 KB", modified: "2026-04-07T07:15:00", folder: "Gestão", shared: ["Gabriela", "Camila", "Junior"] },
];

const DRIVE_FOLDERS = ["Todos", "Pedidos", "Relatórios", "Estoque", "Etiquetas", "Financeiro", "Marketing", "Preços", "Contratos", "Documentos", "Backups", "Gestão"];

const FILE_ICONS = {
  xlsx: { color: "#00c875", label: "XLS" }, pdf: { color: "#e2445c", label: "PDF" }, docx: { color: "#579bfc", label: "DOC" },
  png: { color: "#fdab3d", label: "PNG" }, jpg: { color: "#fdab3d", label: "JPG" }, zip: { color: "#778ca3", label: "ZIP" },
  csv: { color: "#a25ddc", label: "CSV" }, psd: { color: "#401694", label: "PSD" },
};

function GoogleDrivePanel({ onClose, onAttachFile }) {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [files, setFiles] = useState(INITIAL_DRIVE_FILES);
  const [folder, setFolder] = useState("Todos");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState("modified");
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [viewMode, setViewMode] = useState("list");

  const handleConnect = () => {
    setConnecting(true);
    setTimeout(() => { setConnecting(false); setConnected(true); setLastSync(new Date().toISOString()); }, 2000);
  };

  const handleSync = () => {
    setSyncing(true);
    setTimeout(() => {
      const newFile = { id: "df" + Date.now(), name: "Sync_" + new Date().toLocaleDateString("pt-BR").replace(/\//g, "-") + ".log", type: "csv", size: "12 KB", modified: new Date().toISOString(), folder: "Backups", shared: [] };
      setFiles(prev => [newFile, ...prev]);
      setSyncing(false);
      setLastSync(new Date().toISOString());
    }, 1500);
  };

  const handleUpload = () => {
    setUploadProgress(0);
    const interval = setInterval(() => {
      setUploadProgress(prev => {
        if (prev >= 100) { clearInterval(interval); setTimeout(() => {
          const names = ["Novo_Documento.docx", "Planilha_Atualizada.xlsx", "Foto_Produto.jpg", "Relatorio_Final.pdf"];
          const types = ["docx", "xlsx", "jpg", "pdf"];
          const sizes = ["234 KB", "1.1 MB", "2.8 MB", "567 KB"];
          const i = Math.floor(Math.random() * names.length);
          setFiles(prev => [{ id: "df" + Date.now(), name: names[i], type: types[i], size: sizes[i], modified: new Date().toISOString(), folder: folder === "Todos" ? "Documentos" : folder, shared: [] }, ...prev]);
          setUploadProgress(null);
        }, 300); return 100; }
        return prev + Math.random() * 20 + 5;
      });
    }, 200);
  };

  const toggleSelect = (id) => setSelectedFiles(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  const handleAttachSelected = () => {
    const sel = files.filter(f => selectedFiles.includes(f.id));
    sel.forEach(f => onAttachFile && onAttachFile(f));
    setSelectedFiles([]);
  };

  const filtered = useMemo(() => {
    let f = files;
    if (folder !== "Todos") f = f.filter(x => x.folder === folder);
    if (search) { const q = search.toLowerCase(); f = f.filter(x => x.name.toLowerCase().includes(q)); }
    if (sortBy === "modified") f = [...f].sort((a, b) => new Date(b.modified) - new Date(a.modified));
    else if (sortBy === "name") f = [...f].sort((a, b) => a.name.localeCompare(b.name));
    else if (sortBy === "size") f = [...f].sort((a, b) => parseFloat(b.size) - parseFloat(a.size));
    return f;
  }, [files, folder, search, sortBy]);

  const storageUsed = useMemo(() => {
    const total = files.reduce((a, f) => {
      const v = parseFloat(f.size);
      if (f.size.includes("MB")) return a + v;
      if (f.size.includes("KB")) return a + v / 1024;
      return a + v / 1024 / 1024;
    }, 0);
    return total.toFixed(1);
  }, [files]);

  if (!connected) {
    return (
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, backdropFilter: "blur(3px)" }} onClick={onClose}>
        <div style={{ background: "#1a1d23", borderRadius: 20, padding: 36, width: 440, maxWidth: "92vw", border: "1px solid #2a2d35", textAlign: "center" }} onClick={e => e.stopPropagation()}>
          {/* Google Drive Icon */}
          <div style={{ width: 72, height: 72, borderRadius: 18, background: "linear-gradient(135deg, #4285f4, #34a853, #fbbc05, #ea4335)", display: "inline-flex", alignItems: "center", justifyContent: "center", marginBottom: 20, boxShadow: "0 8px 32px rgba(66,133,244,.3)" }}>
            <svg width="36" height="36" viewBox="0 0 24 24" fill="#fff"><path d="M7.71 3.5L1.15 15l2.76 4.5h6.06L7.71 3.5zM8.8 3.5h6.06l6.56 12h-6.06L8.8 3.5zM16.62 16h-6.06l-2.76 4.5h6.06L16.62 16z" opacity=".9"/></svg>
          </div>
          <div style={{ fontWeight: 800, fontSize: 22, color: "#e8eaed", marginBottom: 6 }}>Google Drive</div>
          <div style={{ fontSize: 14, color: "#778ca3", marginBottom: 24 }}>Conecte sua conta para sincronizar arquivos</div>

          <div style={{ background: "#23262e", borderRadius: 12, padding: 16, marginBottom: 24, border: "1px solid #333", textAlign: "left" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 44, height: 44, borderRadius: "50%", background: "linear-gradient(135deg, #e2445c, #ff642e)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 18 }}>D</div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15, color: "#e8eaed" }}>{DRIVE_ACCOUNT.name}</div>
                <div style={{ fontSize: 12, color: "#778ca3" }}>{DRIVE_ACCOUNT.email}</div>
              </div>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 24, textAlign: "left" }}>
            {["Acessar e gerenciar arquivos do Drive", "Sincronizar documentos automaticamente", "Anexar arquivos do Drive às tarefas"].map((t, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#a5b1c2" }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#00c875" strokeWidth="2"><path d="M20 6L9 17l-5-5"/></svg> {t}
              </div>
            ))}
          </div>

          <button onClick={handleConnect} disabled={connecting} style={{ width: "100%", padding: 14, borderRadius: 12, border: "none", background: connecting ? "#333" : "#4285f4", color: "#fff", fontSize: 15, fontWeight: 700, cursor: connecting ? "wait" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, boxShadow: connecting ? "none" : "0 4px 16px rgba(66,133,244,.4)" }}>
            {connecting ? (<><div style={{ width: 18, height: 18, border: "2px solid rgba(255,255,255,.3)", borderTop: "2px solid #fff", borderRadius: "50%", animation: "spin .6s linear infinite" }} /> Conectando...</>) : (<><svg width="20" height="20" viewBox="0 0 24 24" fill="#fff"><path d="M7.71 3.5L1.15 15l2.76 4.5h6.06L7.71 3.5zM8.8 3.5h6.06l6.56 12h-6.06L8.8 3.5zM16.62 16h-6.06l-2.76 4.5h6.06L16.62 16z" opacity=".9"/></svg> Conectar com Google</>)}
          </button>
          <button onClick={onClose} style={{ width: "100%", padding: 10, borderRadius: 10, border: "1px solid #444", background: "transparent", color: "#778ca3", fontSize: 13, cursor: "pointer", marginTop: 10 }}>Cancelar</button>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  // Connected - File browser
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", display: "flex", justifyContent: "flex-end", zIndex: 100, backdropFilter: "blur(3px)" }} onClick={onClose}>
      <div style={{ width: 560, maxWidth: "96vw", background: "#1a1d23", height: "100%", display: "flex", flexDirection: "column", animation: "slideIn .2s ease", borderLeft: "1px solid #2a2d35" }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ padding: "14px 18px", borderBottom: "1px solid #2a2d35", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 34, height: 34, borderRadius: 8, background: "linear-gradient(135deg, #4285f4, #34a853)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="#fff"><path d="M7.71 3.5L1.15 15l2.76 4.5h6.06L7.71 3.5zM8.8 3.5h6.06l6.56 12h-6.06L8.8 3.5zM16.62 16h-6.06l-2.76 4.5h6.06L16.62 16z" opacity=".9"/></svg>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: "#e8eaed" }}>Google Drive</div>
            <div style={{ fontSize: 11, color: "#778ca3" }}>{DRIVE_ACCOUNT.email}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#00c875" }} />
            <span style={{ fontSize: 10, color: "#00c875", fontWeight: 600 }}>Conectado</span>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#778ca3", fontSize: 20, cursor: "pointer", padding: "2px 6px" }}>×</button>
        </div>

        {/* Action bar */}
        <div style={{ padding: "10px 18px", borderBottom: "1px solid #2a2d35", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={handleSync} disabled={syncing} style={{ background: syncing ? "#333" : "#23262e", color: syncing ? "#778ca3" : "#4285f4", border: "1px solid #3a3d45", borderRadius: 8, padding: "6px 12px", fontSize: 11, fontWeight: 600, cursor: syncing ? "wait" : "pointer", display: "flex", alignItems: "center", gap: 5 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: syncing ? "spin .8s linear infinite" : "none" }}><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
            {syncing ? "Sincronizando..." : "Sincronizar"}
          </button>
          <button onClick={handleUpload} style={{ background: "#23262e", color: "#00c875", border: "1px solid #3a3d45", borderRadius: 8, padding: "6px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 5 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>
            Upload
          </button>
          {selectedFiles.length > 0 && (
            <button onClick={handleAttachSelected} style={{ background: "#6c5ce7", color: "#fff", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
              📎 Anexar {selectedFiles.length} arquivo(s)
            </button>
          )}
          <div style={{ flex: 1 }} />
          {lastSync && <span style={{ fontSize: 10, color: "#556" }}>Última sync: {new Date(lastSync).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</span>}
        </div>

        {/* Upload progress */}
        {uploadProgress !== null && (
          <div style={{ padding: "8px 18px", borderBottom: "1px solid #2a2d35" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 11, color: "#a5b1c2" }}>Enviando arquivo...</span>
              <span style={{ fontSize: 11, color: "#6c5ce7", fontWeight: 600 }}>{Math.min(100, Math.round(uploadProgress))}%</span>
            </div>
            <div style={{ height: 4, background: "#333", borderRadius: 2 }}><div style={{ width: `${Math.min(100, uploadProgress)}%`, height: "100%", background: "linear-gradient(90deg, #4285f4, #00c875)", borderRadius: 2, transition: "width .2s" }} /></div>
          </div>
        )}

        {/* Search + filters */}
        <div style={{ padding: "10px 18px", borderBottom: "1px solid #2a2d35", display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ position: "relative", flex: 1 }}>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar arquivos..." style={{ width: "100%", padding: "7px 8px 7px 28px", borderRadius: 8, border: "1px solid #333", background: "#13151a", color: "#e8eaed", fontSize: 12, outline: "none", boxSizing: "border-box" }} />
            <span style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "#556", fontSize: 12 }}>🔍</span>
          </div>
          <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={{ padding: "7px 8px", borderRadius: 8, border: "1px solid #333", background: "#13151a", color: "#e8eaed", fontSize: 11 }}>
            <option value="modified">Recentes</option>
            <option value="name">Nome</option>
            <option value="size">Tamanho</option>
          </select>
          <div style={{ display: "flex", background: "#13151a", borderRadius: 6, border: "1px solid #333" }}>
            <div onClick={() => setViewMode("list")} style={{ padding: "5px 8px", cursor: "pointer", color: viewMode === "list" ? "#4285f4" : "#556", borderRadius: "6px 0 0 6px", background: viewMode === "list" ? "rgba(66,133,244,.1)" : "transparent" }}>☰</div>
            <div onClick={() => setViewMode("grid")} style={{ padding: "5px 8px", cursor: "pointer", color: viewMode === "grid" ? "#4285f4" : "#556", borderRadius: "0 6px 6px 0", background: viewMode === "grid" ? "rgba(66,133,244,.1)" : "transparent" }}>▦</div>
          </div>
        </div>

        {/* Folder tabs */}
        <div style={{ padding: "8px 18px", borderBottom: "1px solid #2a2d35", display: "flex", gap: 4, overflowX: "auto", flexShrink: 0 }}>
          {DRIVE_FOLDERS.map(f => (
            <button key={f} onClick={() => setFolder(f)} style={{ padding: "4px 10px", borderRadius: 6, border: "none", fontSize: 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", background: folder === f ? "#4285f4" : "#23262e", color: folder === f ? "#fff" : "#778ca3", transition: "all .15s" }}>{f}</button>
          ))}
        </div>

        {/* Files */}
        <div style={{ flex: 1, overflow: "auto", padding: viewMode === "grid" ? 14 : 0 }}>
          {viewMode === "list" ? (
            <div>
              {filtered.map(f => {
                const ic = FILE_ICONS[f.type] || { color: "#778ca3", label: f.type.toUpperCase().slice(0, 3) };
                const sel = selectedFiles.includes(f.id);
                return (
                  <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 18px", borderBottom: "1px solid #1e2028", cursor: "pointer", background: sel ? "rgba(66,133,244,.08)" : "transparent", transition: "background .1s" }}
                    onMouseEnter={e => { if (!sel) e.currentTarget.style.background = "rgba(255,255,255,.02)"; }} onMouseLeave={e => { if (!sel) e.currentTarget.style.background = "transparent"; }}>
                    <div onClick={() => toggleSelect(f.id)} style={{ width: 18, height: 18, borderRadius: 4, border: sel ? "none" : "2px solid #444", background: sel ? "#4285f4" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#fff", flexShrink: 0, cursor: "pointer" }}>{sel ? "✓" : ""}</div>
                    <div style={{ width: 36, height: 36, borderRadius: 8, background: ic.color + "20", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <span style={{ fontSize: 10, fontWeight: 800, color: ic.color }}>{ic.label}</span>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#e8eaed", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.name}</div>
                      <div style={{ fontSize: 10, color: "#556", display: "flex", gap: 8 }}>
                        <span>📁 {f.folder}</span><span>{f.size}</span><span>{new Date(f.modified).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" })}</span>
                      </div>
                    </div>
                    {f.shared.length > 0 && <div style={{ display: "flex", paddingLeft: 4 }}>{f.shared.slice(0, 3).map((n, i) => <div key={i} style={{ width: 20, height: 20, borderRadius: "50%", background: PEOPLE_COLORS[n] || "#888", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 9, fontWeight: 700, marginLeft: -4, border: "2px solid #1a1d23" }}>{n[0]}</div>)}</div>}
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 10 }}>
              {filtered.map(f => {
                const ic = FILE_ICONS[f.type] || { color: "#778ca3", label: f.type.toUpperCase().slice(0, 3) };
                const sel = selectedFiles.includes(f.id);
                return (
                  <div key={f.id} onClick={() => toggleSelect(f.id)} style={{ background: sel ? "rgba(66,133,244,.12)" : "#23262e", borderRadius: 10, padding: 14, cursor: "pointer", border: sel ? "2px solid #4285f4" : "1px solid #333", transition: "all .15s", textAlign: "center" }}
                    onMouseEnter={e => e.currentTarget.style.transform = "translateY(-2px)"} onMouseLeave={e => e.currentTarget.style.transform = "none"}>
                    <div style={{ width: 44, height: 44, borderRadius: 10, background: ic.color + "20", display: "inline-flex", alignItems: "center", justifyContent: "center", marginBottom: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 800, color: ic.color }}>{ic.label}</span>
                    </div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "#e8eaed", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.name}</div>
                    <div style={{ fontSize: 10, color: "#556", marginTop: 2 }}>{f.size}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer - storage */}
        <div style={{ padding: "10px 18px", borderTop: "1px solid #2a2d35", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ fontSize: 11, color: "#778ca3" }}>{storageUsed} MB de 15 GB usados</span>
              <span style={{ fontSize: 11, color: "#556" }}>{files.length} arquivos</span>
            </div>
            <div style={{ height: 4, background: "#333", borderRadius: 2 }}>
              <div style={{ width: `${(parseFloat(storageUsed) / 15000) * 100}%`, minWidth: 4, height: "100%", background: "linear-gradient(90deg, #4285f4, #34a853)", borderRadius: 2 }} />
            </div>
          </div>
          <button onClick={() => { setConnected(false); }} style={{ background: "transparent", color: "#e2445c", border: "1px solid rgba(226,68,92,.3)", borderRadius: 8, padding: "5px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Desconectar</button>
        </div>
      </div>
    </div>
  );
}

// ─── ADD TASK MODAL ──────────────────────────────────────────────────────────
function AddTaskModal({ onClose, onAdd, allPeople }) {
  const [name, setName] = useState(""); const [priority, setPriority] = useState("Média"); const [responsible, setResponsible] = useState([]);
  const handleAdd = () => { if (!name.trim()) return; onAdd({ id: "t" + Date.now(), name: name.trim(), responsible: responsible.length > 0 ? responsible : ["Gabriela"], status: "Não iniciado", priority, deadline: null, totalOrders: 0, totalCancellations: 0, custom: {}, updates: [], subitems: [] }); onClose(); };
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, backdropFilter: "blur(4px)" }} onClick={onClose}>
      <div style={{ background: "#23262e", borderRadius: 14, padding: 24, width: 420, maxWidth: "92vw", border: "1px solid #333" }} onClick={e => e.stopPropagation()}>
        <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 16 }}>Nova Tarefa</div>
        <div style={{ marginBottom: 10 }}><label style={{ fontSize: 11, color: "#778ca3", fontWeight: 600, display: "block", marginBottom: 3 }}>Nome</label><input value={name} onChange={e => setName(e.target.value)} placeholder="Ex: Verificar estoque" style={{ width: "100%", padding: "8px 10px", borderRadius: 7, border: "1px solid #444", background: "#1a1d23", color: "#e8eaed", fontSize: 13, outline: "none", boxSizing: "border-box" }} autoFocus /></div>
        <div style={{ marginBottom: 10 }}><label style={{ fontSize: 11, color: "#778ca3", fontWeight: 600, display: "block", marginBottom: 5 }}>Responsáveis</label>
          <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap", background: "#1a1d23", border: "1px solid #444", borderRadius: 7, padding: "5px 8px", minHeight: 36 }}>
            {responsible.map((r, i) => (<div key={i} style={{ display: "flex", alignItems: "center", gap: 3, background: "#2a2d35", borderRadius: 14, padding: "2px 8px 2px 2px" }}><Avatar name={r} size={18} /><span style={{ fontSize: 11, color: "#e8eaed", marginLeft: 3 }}>{r}</span><span onClick={() => setResponsible(responsible.filter((_, j) => j !== i))} style={{ cursor: "pointer", color: "#e2445c", fontSize: 12, marginLeft: 3, fontWeight: 700 }}>×</span></div>))}
            <PeoplePicker selected={responsible} onChange={setResponsible} allPeople={allPeople} />
          </div>
        </div>
        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 11, color: "#778ca3", fontWeight: 600, display: "block", marginBottom: 3 }}>Prioridade</label>
          <select value={priority} onChange={e => setPriority(e.target.value)} style={{ width: "100%", padding: "8px 8px", borderRadius: 7, border: "1px solid #444", background: "#1a1d23", color: "#e8eaed", fontSize: 12 }}>{PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}</select>
          <div style={{ fontSize: 10, color: "#778ca3", marginTop: 6 }}>📅 Prazo será definido automaticamente como a data de hoje.</div>
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button onClick={onClose} style={{ padding: "8px 16px", borderRadius: 7, border: "1px solid #444", background: "transparent", color: "#a5b1c2", fontSize: 12, cursor: "pointer" }}>Cancelar</button>
          <button onClick={handleAdd} style={{ padding: "8px 20px", borderRadius: 7, border: "none", background: "#6c5ce7", color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Adicionar</button>
        </div>
      </div>
    </div>
  );
}

// ─── ROLE BADGE ──────────────────────────────────────────────────────────────
function RoleBadge({ role, small }) {
  const r = ROLE_CONFIG[role] || ROLE_CONFIG.collaborator;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, background: r.color + "18", color: r.color, padding: small ? "1px 6px" : "2px 8px", borderRadius: 10, fontSize: small ? 9 : 10, fontWeight: 700, border: `1px solid ${r.color}30` }}>
      <span style={{ fontSize: small ? 8 : 10 }}>{r.icon}</span> {r.label}
    </span>
  );
}

// ─── LOCKED FEATURE TOOLTIP ──────────────────────────────────────────────────
function LockedOverlay({ message = "Recurso restrito a administradores" }) {
  return (
    <div style={{ position: "relative", display: "inline-flex" }} title={message}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#556" strokeWidth="2" style={{ opacity: 0.6 }}>
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
      </svg>
    </div>
  );
}

// ─── ADMIN PANEL ─────────────────────────────────────────────────────────────
function ReportsPanel({ onClose, fullscreen, onToggleFullscreen, boardId, boardName }) {
  const [period, setPeriod] = useState("day");
  const [date, setDate] = useState(() => {
    const n = new Date();
    const brt = new Date(n.getTime() + n.getTimezoneOffset() * 60000 - 3 * 3600000);
    return brt.toISOString().slice(0, 10);
  });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    // Relatório é isolado por quadro: sempre pede o do quadro aberto.
    const escopo = boardId ? `&boardId=${encodeURIComponent(boardId)}` : "";
    fetch(`${API_URL}/api/reports?period=${period}&date=${date}${escopo}`, { headers: { Authorization: `Bearer ${getToken()}` } })
      .then(r => r.json())
      .then(d => { if (alive) { setData(d); setLoading(false); } })
      .catch(() => { if (alive) { setData({ error: true }); setLoading(false); } });
    return () => { alive = false; };
  }, [period, date, boardId]);

  const periods = [
    { key: "day", label: "Dia" }, { key: "week", label: "Semana" },
    { key: "month", label: "Mês" }, { key: "year", label: "Ano" }
  ];
  const fmtBR = s => { if (!s) return ""; const [y,m,d] = s.split("-"); return `${d}/${m}/${y}`; };

  const container = fullscreen
    ? { position: "fixed", inset: 0, background: "#13151a", zIndex: 120, display: "flex", flexDirection: "column" }
    : { position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", display: "flex", justifyContent: "flex-end", zIndex: 120, backdropFilter: "blur(3px)" };

  const inner = fullscreen
    ? { flex: 1, display: "flex", flexDirection: "column", background: "#13151a", color: "#e8eaed" }
    : { width: 520, maxWidth: "95vw", background: "#1a1d23", height: "100%", display: "flex", flexDirection: "column", animation: "slideIn .2s ease", borderLeft: "1px solid #2a2d35" };

  const d = data || {};
  const maxDay = d.byDay ? Math.max(1, ...d.byDay.map(x => x.value)) : 1;
  const maxUser = d.perUser ? Math.max(1, ...d.perUser.map(x => x.value)) : 1;
  const maxTask = d.perTask ? Math.max(1, ...d.perTask.map(x => x.value)) : 1;

  return (
    <div style={container} onClick={!fullscreen ? onClose : undefined}>
      <div style={inner} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={{ padding: "16px 20px", borderBottom: "1px solid #2a2d35", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: 8, background: "linear-gradient(135deg, #00c875, #579bfc)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"/><path d="M7 14l3-3 4 4 5-6"/></svg>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: "#e8eaed" }}>Relatório Diário</div>
            <div style={{ fontSize: 11, color: "#778ca3", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {/* Deixa explícito o escopo: os números são só deste quadro. */}
              {(boardName || d.boardName) && <span style={{ color: "#6c5ce7", fontWeight: 600 }}>{boardName || d.boardName} · </span>}
              {d.lastRolloverDate ? `Último fechamento: ${fmtBR(d.lastRolloverDate)}` : "Sem fechamentos ainda"}
            </div>
          </div>
          <button onClick={onToggleFullscreen} title={fullscreen ? "Reduzir" : "Expandir"} style={{ background: "none", border: "1px solid #3a3d45", color: "#a5b1c2", fontSize: 12, cursor: "pointer", padding: "5px 10px", borderRadius: 6 }}>
            {fullscreen ? "⤡ Reduzir" : "⤢ Tela cheia"}
          </button>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#778ca3", fontSize: 22, cursor: "pointer", padding: "4px 8px" }}>×</button>
        </div>

        {/* Controls */}
        <div style={{ padding: "12px 20px", borderBottom: "1px solid #2a2d35", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ display: "flex", background: "#13151a", borderRadius: 7, overflow: "hidden", border: "1px solid #2a2d35" }}>
            {periods.map(p => (
              <button key={p.key} onClick={() => setPeriod(p.key)}
                style={{ padding: "6px 14px", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600, background: period === p.key ? "#00c875" : "transparent", color: period === p.key ? "#fff" : "#778ca3" }}>
                {p.label}
              </button>
            ))}
          </div>
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            style={{ background: "#13151a", border: "1px solid #2a2d35", color: "#e8eaed", padding: "6px 10px", borderRadius: 7, fontSize: 12 }} />
          {d.start && d.end && d.start !== d.end && (
            <span style={{ fontSize: 11, color: "#778ca3" }}>{fmtBR(d.start)} → {fmtBR(d.end)}</span>
          )}
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflow: "auto", padding: "16px 20px", display: "flex", flexDirection: "column", gap: 18 }}>
          {loading && <div style={{ textAlign: "center", color: "#778ca3", padding: 40, fontSize: 13 }}>Carregando…</div>}
          {!loading && d.error && <div style={{ textAlign: "center", color: "#e2445c", padding: 40, fontSize: 13 }}>Erro ao carregar relatório.</div>}
          {!loading && !d.error && (
            <>
              {/* Summary card */}
              <div style={{ background: "#1a1d23", borderRadius: 10, padding: 16, border: "1px solid #2a2d35", display: "flex", gap: 20, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontSize: 11, color: "#778ca3", fontWeight: 600 }}>TOTAL NO PERÍODO</div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: "#00c875" }}>{Math.round((d.total || 0) * 100) / 100}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "#778ca3", fontWeight: 600 }}>DIAS COM ATIVIDADE</div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: "#579bfc" }}>{(d.byDay || []).filter(x => x.value > 0).length}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "#778ca3", fontWeight: 600 }}>RESPONSÁVEIS</div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: "#fdab3d" }}>{(d.perUser || []).length}</div>
                </div>
              </div>

              {/* Per day */}
              {(d.byDay || []).length > 0 && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#e8eaed", marginBottom: 8 }}>POR DIA</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {d.byDay.map(x => (
                      <div key={x.date} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
                        <div style={{ width: 80, color: "#a5b1c2" }}>{fmtBR(x.date)}</div>
                        <div style={{ flex: 1, background: "#13151a", height: 16, borderRadius: 4, overflow: "hidden" }}>
                          <div style={{ width: `${(x.value / maxDay) * 100}%`, height: "100%", background: "linear-gradient(90deg, #00c875, #579bfc)" }} />
                        </div>
                        <div style={{ width: 60, textAlign: "right", color: "#e8eaed", fontWeight: 600 }}>{Math.round(x.value * 100) / 100}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Per user */}
              {(d.perUser || []).length > 0 && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#e8eaed", marginBottom: 8 }}>DESEMPENHO POR RESPONSÁVEL</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {d.perUser.map(x => (
                      <div key={x.name} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
                        <div style={{ width: 140, color: "#e8eaed", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.name}</div>
                        <div style={{ flex: 1, background: "#13151a", height: 16, borderRadius: 4, overflow: "hidden" }}>
                          <div style={{ width: `${(x.value / maxUser) * 100}%`, height: "100%", background: "linear-gradient(90deg, #fdab3d, #e2445c)" }} />
                        </div>
                        <div style={{ width: 60, textAlign: "right", color: "#e8eaed", fontWeight: 700 }}>{x.value}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: 10, color: "#556", marginTop: 6 }}>Valor dividido igualmente quando há co-responsáveis.</div>
                </div>
              )}

              {/* Per task/subitem (more detail in fullscreen) */}
              {(d.perTask || []).length > 0 && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#e8eaed", marginBottom: 8 }}>POR TAREFA / SUBITEM / COLUNA</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {(fullscreen ? d.perTask : d.perTask.slice(0, 10)).map((x, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11, padding: "6px 8px", background: "#1a1d23", borderRadius: 6, border: "1px solid #23262e" }}>
                        <div style={{ flex: 1, overflow: "hidden" }}>
                          <div style={{ color: "#e8eaed", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.task_name || x.task_id}</div>
                          <div style={{ color: "#778ca3", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {x.subitem_name ? `${x.subitem_name} · ` : ""}{x.column_name || x.column_id}
                          </div>
                        </div>
                        <div style={{ width: fullscreen ? 180 : 80, background: "#13151a", height: 12, borderRadius: 3, overflow: "hidden" }}>
                          <div style={{ width: `${(x.value / maxTask) * 100}%`, height: "100%", background: "#579bfc" }} />
                        </div>
                        <div style={{ width: 60, textAlign: "right", color: "#e8eaed", fontWeight: 700 }}>{Math.round(x.value * 100) / 100}</div>
                      </div>
                    ))}
                    {!fullscreen && d.perTask.length > 10 && (
                      <div style={{ fontSize: 10, color: "#556", marginTop: 4, textAlign: "center" }}>+{d.perTask.length - 10} itens — expanda para ver todos</div>
                    )}
                  </div>
                </div>
              )}

              {(!d.perTask || d.perTask.length === 0) && (
                <div style={{ textAlign: "center", padding: "40px 20px", color: "#556" }}>
                  <div style={{ fontSize: 40, marginBottom: 10 }}>📊</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "#778ca3" }}>Sem dados para este período</div>
                  <div style={{ fontSize: 12, color: "#556", marginTop: 4 }}>O relatório começa a acumular a partir do primeiro fechamento diário (00:00 BRT).</div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function AdminPanel({ users, onUpdateRole, onCreateUser, onDeleteUser, onClose, currentUser, currentUserId }) {
  const [confirmAction, setConfirmAction] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [newPass, setNewPass] = useState("");
  const [newRole, setNewRole] = useState("collaborator");
  const [createErr, setCreateErr] = useState("");
  const [creating, setCreating] = useState(false);

  const submitCreate = async () => {
    setCreateErr("");
    if (!newName.trim() || !newUsername.trim() || !newPass) { setCreateErr("Preencha nome, usuário e senha"); return; }
    if (!USERNAME_RE.test(newUsername.trim())) { setCreateErr("Usuário deve ter 3 a 20 caracteres (letras, números, . _ -)"); return; }
    if (newPass.length < 4) { setCreateErr("Senha deve ter pelo menos 4 caracteres"); return; }
    setCreating(true);
    try {
      const r = await onCreateUser({ name: newName.trim(), username: newUsername.trim().toLowerCase(), password: newPass, role: newRole });
      if (r?.error) { setCreateErr(r.error); return; }
      setNewName(""); setNewUsername(""); setNewPass(""); setNewRole("collaborator"); setShowCreate(false);
    } catch (e) {
      setCreateErr("Erro inesperado: " + (e?.message || "tente novamente"));
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = (user) => {
    setConfirmAction({ kind: "delete", user: user.name, userId: user.id, message: `Excluir o usuário "${user.name}"? Esta ação não pode ser desfeita.` });
  };

  const handleRoleChange = (userName, newRole) => {
    if (userName === currentUser && newRole !== "admin") {
      setConfirmAction({ user: userName, role: newRole, message: `Tem certeza que deseja remover seus próprios privilégios de administrador? Você perderá acesso ao painel de administração.` });
      return;
    }
    onUpdateRole(userName, newRole);
  };

  const confirmRoleChange = async () => {
    if (!confirmAction) return;
    if (confirmAction.kind === "delete") {
      await onDeleteUser(confirmAction.userId);
    } else {
      onUpdateRole(confirmAction.user, confirmAction.role);
    }
    setConfirmAction(null);
  };

  const adminCount = users.filter(u => u.role === "admin").length;

  // ─── Zona perigosa: wipe de todas as mensagens (limpeza de teste) ───────────
  const [wipeStep, setWipeStep] = useState(null); // null | 'confirm' | 'done'
  const [wipeCount, setWipeCount] = useState(0);
  const [wiping, setWiping] = useState(false);
  const [wipeResult, setWipeResult] = useState("");
  const startWipe = async () => {
    setWiping(true); setWipeResult("");
    try {
      const r = await apiCall("/admin/wipe-updates?dry=1", { method: "POST" });
      if (!r) { setWipeResult("Falha de conexao"); return; }
      setWipeCount(r.count || 0);
      setWipeStep("confirm");
    } finally { setWiping(false); }
  };
  // Backup do banco pela própria tela: usa a sessão do admin que já está
  // aberta, sem depender de token avulso nem do console do navegador.
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupMsg, setBackupMsg] = useState("");
  const baixarBackup = async () => {
    setBackupBusy(true); setBackupMsg("");
    try {
      const r = await fetch(`${API_URL}/api/admin/backup`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!r.ok) {
        let msg = `Erro ${r.status}`;
        try { msg = (await r.json()).error || msg; } catch {}
        setBackupMsg(`Falhou: ${msg}`);
        return;
      }
      const blob = await r.blob();
      const carimbo = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `database.backup-${carimbo}.sqlite`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      setBackupMsg(`Baixado: ${(blob.size / 1024).toFixed(0)} KB — confira na pasta de downloads.`);
    } catch (e) {
      setBackupMsg("Falhou: sem conexão com o servidor.");
    } finally { setBackupBusy(false); }
  };

  const confirmWipe = async () => {
    setWiping(true); setWipeResult("");
    try {
      const r = await apiCall("/admin/wipe-updates", { method: "POST", returnError: true });
      if (r?.error) { setWipeResult("Erro: " + r.error); setWipeStep("done"); return; }
      setWipeResult(`Apagadas ${r.deleted} mensagem(ns). Backup: ${r.backup}`);
      setWipeStep("done");
    } finally { setWiping(false); }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, backdropFilter: "blur(4px)" }} onClick={onClose}>
      <div style={{ background: "#1a1d23", borderRadius: 18, padding: 0, width: 560, maxWidth: "94vw", border: "1px solid #2a2d35", boxShadow: "0 20px 60px rgba(0,0,0,.5)", overflow: "hidden", maxHeight: "90vh", display: "flex", flexDirection: "column" }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ padding: "20px 24px", borderBottom: "1px solid #2a2d35", background: "linear-gradient(135deg, rgba(226,68,92,.08), rgba(108,92,231,.08))" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 40, height: 40, borderRadius: 10, background: "linear-gradient(135deg, #e2445c, #6c5ce7)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>👑</div>
              <div>
                <div style={{ fontWeight: 800, fontSize: 18, color: "#e8eaed" }}>Painel de Administração</div>
                <div style={{ fontSize: 12, color: "#778ca3" }}>Gerenciar usuários e permissões</div>
              </div>
            </div>
            <button onClick={onClose} style={{ background: "none", border: "none", color: "#778ca3", fontSize: 22, cursor: "pointer" }}>×</button>
          </div>
        </div>

        {/* Stats */}
        <div style={{ padding: "14px 24px", borderBottom: "1px solid #2a2d35", display: "flex", gap: 16 }}>
          {[
            { label: "Total", value: users.length, color: "#579bfc" },
            { label: "Admins", value: users.filter(u => u.role === "admin").length, color: "#e2445c" },
            { label: "Colaboradores", value: users.filter(u => u.role === "collaborator").length, color: "#579bfc" },
          ].map((s, i) => (
            <div key={i} style={{ background: "#23262e", borderRadius: 10, padding: "10px 16px", flex: 1, textAlign: "center", border: "1px solid #333" }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 10, color: "#778ca3", fontWeight: 600 }}>{s.label}</div>
            </div>
          ))}
        </div>

        {/* Backup do banco */}
        <div style={{ padding: "12px 24px", borderBottom: "1px solid #2a2d35" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#778ca3", textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 8 }}>Backup</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, background: "#23262e", border: "1px solid #333", borderRadius: 10, padding: "10px 12px" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: "#e8eaed" }}>Baixar cópia do banco de dados</div>
              <div style={{ fontSize: 10.5, color: "#778ca3", marginTop: 2 }}>
                {backupMsg || "Arquivo .sqlite com tudo: usuários, quadros, tarefas, relatórios e histórico."}
              </div>
            </div>
            <button onClick={baixarBackup} disabled={backupBusy}
              style={{ background: backupBusy ? "#333" : "#00c875", color: "#fff", border: "none", borderRadius: 8, padding: "9px 14px", fontSize: 12, fontWeight: 700, cursor: backupBusy ? "default" : "pointer", whiteSpace: "nowrap" }}>
              {backupBusy ? "Baixando..." : "⬇ Baixar backup"}
            </button>
          </div>
        </div>

        {/* Permissions legend */}
        <div style={{ padding: "12px 24px", borderBottom: "1px solid #2a2d35" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#778ca3", textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 8 }}>Permissões por cargo</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div style={{ background: "#23262e", borderRadius: 8, padding: 10, border: "1px solid #e2445c30" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}><span>👑</span><span style={{ fontWeight: 700, fontSize: 12, color: "#e2445c" }}>Administrador</span></div>
              <div style={{ fontSize: 10, color: "#a5b1c2", lineHeight: 1.6 }}>
                ✅ Criar/excluir tarefas e colunas<br/>✅ Gerenciar usuários e cargos<br/>✅ Configurar automações IA<br/>✅ Exportar dados<br/>✅ Acesso total ao sistema
              </div>
            </div>
            <div style={{ background: "#23262e", borderRadius: 8, padding: 10, border: "1px solid #579bfc30" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}><span>👤</span><span style={{ fontWeight: 700, fontSize: 12, color: "#579bfc" }}>Colaborador</span></div>
              <div style={{ fontSize: 10, color: "#a5b1c2", lineHeight: 1.6 }}>
                ✅ Editar tarefas existentes<br/>✅ Ver e enviar relatórios<br/>✅ Acessar Google Drive<br/>✅ Criar colunas<br/>✅ Criar automações IA<br/>🚫 Excluir colunas<br/>🚫 Gerenciar usuários
              </div>
            </div>
          </div>
        </div>

        {/* Users list */}
        <div style={{ flex: 1, overflow: "auto", padding: "12px 24px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#778ca3", textTransform: "uppercase", letterSpacing: ".5px" }}>Usuários ({users.length})</div>
            <button onClick={() => setShowCreate(s => !s)} style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: showCreate ? "#333" : "#00c875", color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
              {showCreate ? "Cancelar" : "+ Novo usuário"}
            </button>
          </div>
          {showCreate && (
            <div style={{ background: "#23262e", border: "1px solid #00c87530", borderRadius: 10, padding: 14, marginBottom: 12, display: "flex", flexDirection: "column", gap: 8 }}>
              <input value={newName} onChange={e => { setNewName(e.target.value); setCreateErr(""); }} placeholder="Nome completo"
                style={{ padding: "8px 10px", borderRadius: 6, border: "1px solid #444", background: "#13151a", color: "#e8eaed", fontSize: 12, outline: "none" }} />
              <input value={newUsername} onChange={e => { setNewUsername(e.target.value); setCreateErr(""); }} placeholder="nome.de.usuario" type="text" autoCapitalize="none" spellCheck={false}
                style={{ padding: "8px 10px", borderRadius: 6, border: "1px solid #444", background: "#13151a", color: "#e8eaed", fontSize: 12, outline: "none" }} />
              <input value={newPass} onChange={e => { setNewPass(e.target.value); setCreateErr(""); }} placeholder="Senha temporária (mín. 4)" type="password"
                style={{ padding: "8px 10px", borderRadius: 6, border: "1px solid #444", background: "#13151a", color: "#e8eaed", fontSize: 12, outline: "none" }} />
              <select value={newRole} onChange={e => setNewRole(e.target.value)}
                style={{ padding: "8px 10px", borderRadius: 6, border: "1px solid #444", background: "#13151a", color: "#e8eaed", fontSize: 12, cursor: "pointer" }}>
                <option value="collaborator">👤 Colaborador</option>
                <option value="admin">👑 Administrador</option>
              </select>
              {createErr && <div style={{ fontSize: 11, color: "#e2445c" }}>{createErr}</div>}
              <button onClick={submitCreate} disabled={creating} style={{ padding: "8px", borderRadius: 6, border: "none", background: creating ? "#555" : "#00c875", color: "#fff", fontSize: 12, fontWeight: 700, cursor: creating ? "wait" : "pointer" }}>
                {creating ? "Criando..." : "Criar usuário"}
              </button>
              <div style={{ fontSize: 10, color: "#556" }}>O usuário poderá trocar a senha depois no próprio perfil.</div>
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {users.map(u => {
              const rc = ROLE_CONFIG[u.role] || ROLE_CONFIG.collaborator;
              const isCurrentUser = u.name === currentUser;
              const isLastAdmin = u.role === "admin" && adminCount <= 1;
              return (
                <div key={u.name} style={{ background: "#23262e", borderRadius: 10, padding: "12px 14px", display: "flex", alignItems: "center", gap: 12, border: isCurrentUser ? "1px solid #6c5ce740" : "1px solid #333", transition: "all .15s" }}>
                  <div style={{ width: 38, height: 38, borderRadius: "50%", background: PEOPLE_COLORS[u.name] || "#888", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 16, fontWeight: 700, flexShrink: 0, border: u.role === "admin" ? "2px solid #e2445c" : "2px solid transparent" }}>
                    {u.name[0]}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontWeight: 700, fontSize: 14, color: "#e8eaed" }}>{u.name}</span>
                      {isCurrentUser && <span style={{ fontSize: 9, color: "#6c5ce7", fontWeight: 600, background: "rgba(108,92,231,.15)", padding: "1px 6px", borderRadius: 8 }}>Você</span>}
                    </div>
                    <div style={{ fontSize: 11, color: "#778ca3" }}>@{u.username}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <RoleBadge role={u.role} />
                    <select value={u.role} onChange={e => handleRoleChange(u.name, e.target.value)}
                      disabled={isLastAdmin && u.role === "admin"}
                      title={isLastAdmin && u.role === "admin" ? "Precisa de pelo menos 1 administrador" : ""}
                      style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid #444", background: "#13151a", color: "#e8eaed", fontSize: 11, cursor: isLastAdmin && u.role === "admin" ? "not-allowed" : "pointer", opacity: isLastAdmin && u.role === "admin" ? 0.5 : 1 }}>
                      <option value="admin">👑 Administrador</option>
                      <option value="collaborator">👤 Colaborador</option>
                    </select>
                    {u.id !== currentUserId && !(isLastAdmin && u.role === "admin") && (
                      <button onClick={() => handleDelete(u)} title="Excluir usuário"
                        style={{ background: "transparent", border: "1px solid #e2445c40", color: "#e2445c", padding: "4px 8px", borderRadius: 6, cursor: "pointer", fontSize: 11 }}
                        onMouseEnter={e => e.currentTarget.style.background = "rgba(226,68,92,.1)"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                        🗑
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Zona perigosa */}
        <div style={{ padding: "14px 24px", borderTop: "1px solid #2a2d35", background: "rgba(226,68,92,.04)" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#e2445c", textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 8 }}>⚠️ Zona perigosa</div>
          {wipeStep === null && (
            <button onClick={startWipe} disabled={wiping}
              style={{ padding: "7px 14px", borderRadius: 7, border: "1px solid #e2445c60", background: "transparent", color: "#e2445c", fontSize: 12, fontWeight: 600, cursor: wiping ? "wait" : "pointer" }}>
              {wiping ? "Verificando..." : "🗑 Apagar TODAS as mensagens (limpeza de teste)"}
            </button>
          )}
          {wipeStep === "confirm" && (
            <div>
              <div style={{ fontSize: 12, color: "#a5b1c2", marginBottom: 10 }}>
                Vai apagar <b style={{ color: "#e2445c" }}>{wipeCount}</b> mensagem(ns) de todos os quadros. Um backup do banco será gravado antes em <code>backups/database.pre-wipe-...sqlite</code>. <b>Esta ação não pode ser desfeita pela interface.</b>
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button onClick={() => { setWipeStep(null); setWipeResult(""); }} disabled={wiping} style={{ padding: "7px 14px", borderRadius: 7, border: "1px solid #444", background: "transparent", color: "#a5b1c2", fontSize: 12, cursor: "pointer" }}>Cancelar</button>
                <button onClick={confirmWipe} disabled={wiping} style={{ padding: "7px 14px", borderRadius: 7, border: "none", background: "#e2445c", color: "#fff", fontSize: 12, fontWeight: 600, cursor: wiping ? "wait" : "pointer" }}>{wiping ? "Apagando..." : "Confirmar exclusão"}</button>
              </div>
            </div>
          )}
          {wipeStep === "done" && (
            <div>
              <div style={{ fontSize: 12, color: wipeResult.startsWith("Erro") ? "#e2445c" : "#00c875", marginBottom: 8 }}>{wipeResult}</div>
              <button onClick={() => { setWipeStep(null); setWipeResult(""); }} style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #444", background: "transparent", color: "#a5b1c2", fontSize: 11, cursor: "pointer" }}>Fechar</button>
            </div>
          )}
        </div>

        {/* Confirm dialog */}
        {confirmAction && (
          <div style={{ padding: "14px 24px", borderTop: "1px solid #2a2d35", background: "rgba(226,68,92,.05)" }}>
            <div style={{ fontSize: 13, color: "#e2445c", fontWeight: 600, marginBottom: 8 }}>⚠️ Confirmação necessária</div>
            <div style={{ fontSize: 12, color: "#a5b1c2", marginBottom: 12 }}>{confirmAction.message}</div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setConfirmAction(null)} style={{ padding: "7px 14px", borderRadius: 7, border: "1px solid #444", background: "transparent", color: "#a5b1c2", fontSize: 12, cursor: "pointer" }}>Cancelar</button>
              <button onClick={confirmRoleChange} style={{ padding: "7px 14px", borderRadius: 7, border: "none", background: "#e2445c", color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Confirmar</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── PROFILE EDITOR ──────────────────────────────────────────────────────────
const AVATAR_COLORS = ["#ff642e", "#fdab3d", "#a25ddc", "#00c875", "#579bfc", "#e2445c", "#ff158a", "#037f4c", "#0086c0", "#9d50dd", "#ffcb00", "#784bd1"];
const DEPARTMENTS = ["Operações", "Vendas", "Marketing", "Financeiro", "Logística", "Atendimento", "Administrativo", "TI"];

function ProfileEditor({ userData, onSave, onClose, allUsers }) {
  const [name, setName] = useState(userData.name || "");
  const [username, setUsername] = useState(userData.username || "");
  const [phone, setPhone] = useState(userData.phone || "");
  const [department, setDepartment] = useState(userData.department || "");
  const [bio, setBio] = useState(userData.bio || "");
  const [avatarColor, setAvatarColor] = useState(PEOPLE_COLORS[userData.name] || "#888");
  const [currentPass, setCurrentPass] = useState("");
  const [newPass, setNewPass] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [showPassSection, setShowPassSection] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("info");

  const handleSave = async () => {
    setError("");
    if (!name.trim()) { setError("Nome é obrigatório"); return; }
    const un = username.trim().toLowerCase();
    if (!USERNAME_RE.test(un)) { setError("Usuário deve ter 3 a 20 caracteres (letras, números, . _ -)"); return; }
    const userTaken = allUsers.find(u => (u.username || "").toLowerCase() === un && u.name !== userData.name);
    if (userTaken) { setError("Este nome de usuário já está em uso por " + userTaken.name); return; }

    if (showPassSection && newPass) {
      if (!currentPass) { setError("Digite a senha atual"); return; }
      if (newPass.length < 4) { setError("Nova senha deve ter pelo menos 4 caracteres"); return; }
      if (newPass !== confirmPass) { setError("As senhas não coincidem"); return; }

      // Verify current password via API
      const check = await apiCall("/auth/login", { method: "POST", body: JSON.stringify({ username: userData.username, password: currentPass }) });
      if (!check || !check.token) { setError("Senha atual incorreta"); return; }
    }

    onSave({
      name: name.trim(),
      username: un,
      phone: phone.trim(),
      department,
      bio: bio.trim(),
      avatarColor,
      password: (showPassSection && newPass) ? newPass : undefined,
    });
    setSaved(true);
    setShowPassSection(false); setCurrentPass(""); setNewPass(""); setConfirmPass("");
    setTimeout(() => setSaved(false), 2000);
  };

  const tabs = [
    { key: "info", label: "Informações", icon: "👤" },
    { key: "security", label: "Segurança", icon: "🔒" },
    { key: "appearance", label: "Aparência", icon: "🎨" },
  ];

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, backdropFilter: "blur(4px)" }} onClick={onClose}>
      <div style={{ background: "#1a1d23", borderRadius: 18, width: 520, maxWidth: "94vw", border: "1px solid #2a2d35", boxShadow: "0 20px 60px rgba(0,0,0,.5)", overflow: "hidden", maxHeight: "92vh", display: "flex", flexDirection: "column" }} onClick={e => e.stopPropagation()}>

        {/* Header with avatar preview */}
        <div style={{ padding: "24px 28px 20px", background: "linear-gradient(135deg, rgba(108,92,231,.1), rgba(87,155,252,.08))", borderBottom: "1px solid #2a2d35" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{ width: 64, height: 64, borderRadius: 16, background: avatarColor, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 26, fontWeight: 800, flexShrink: 0, boxShadow: `0 4px 16px ${avatarColor}40`, border: "3px solid rgba(255,255,255,.2)" }}>
              {name ? name[0].toUpperCase() : "?"}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 800, fontSize: 20, color: "#e8eaed", marginBottom: 2 }}>{name || "Seu nome"}</div>
              <div style={{ fontSize: 12, color: "#778ca3", display: "flex", alignItems: "center", gap: 6 }}>
                {username ? `@${username}` : "@usuario"}
                <RoleBadge role={userData.role} small />
              </div>
              {department && <div style={{ fontSize: 11, color: "#556", marginTop: 2 }}>📍 {department}</div>}
            </div>
            <button onClick={onClose} style={{ background: "none", border: "none", color: "#778ca3", fontSize: 22, cursor: "pointer", alignSelf: "flex-start" }}>×</button>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", borderBottom: "1px solid #2a2d35" }}>
          {tabs.map(t => (
            <div key={t.key} onClick={() => setTab(t.key)} style={{ flex: 1, padding: "10px 0", textAlign: "center", cursor: "pointer", fontSize: 12, fontWeight: 600, color: tab === t.key ? "#6c5ce7" : "#778ca3", borderBottom: tab === t.key ? "2px solid #6c5ce7" : "2px solid transparent", transition: "all .15s", display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}>
              <span style={{ fontSize: 13 }}>{t.icon}</span> {t.label}
            </div>
          ))}
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflow: "auto", padding: "20px 28px" }}>

          {tab === "info" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#778ca3", display: "block", marginBottom: 5 }}>Nome completo</label>
                <input value={name} onChange={e => setName(e.target.value)} style={{ width: "100%", padding: "11px 14px", borderRadius: 10, border: "1px solid #333", background: "#13151a", color: "#e8eaed", fontSize: 14, outline: "none", boxSizing: "border-box" }} />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#778ca3", display: "block", marginBottom: 5 }}>Nome de usuário</label>
                <input value={username} onChange={e => setUsername(e.target.value)} type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} style={{ width: "100%", padding: "11px 14px", borderRadius: 10, border: "1px solid #333", background: "#13151a", color: "#e8eaed", fontSize: 14, outline: "none", boxSizing: "border-box" }} />
                <div style={{ fontSize: 10, color: "#556", marginTop: 4 }}>Usado para entrar no sistema, junto com a senha.</div>
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#778ca3", display: "block", marginBottom: 5 }}>Telefone</label>
                <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="(00) 00000-0000" style={{ width: "100%", padding: "11px 14px", borderRadius: 10, border: "1px solid #333", background: "#13151a", color: "#e8eaed", fontSize: 14, outline: "none", boxSizing: "border-box" }} />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#778ca3", display: "block", marginBottom: 5 }}>Departamento</label>
                <select value={department} onChange={e => setDepartment(e.target.value)} style={{ width: "100%", padding: "11px 14px", borderRadius: 10, border: "1px solid #333", background: "#13151a", color: "#e8eaed", fontSize: 14, boxSizing: "border-box" }}>
                  <option value="">Selecionar...</option>
                  {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#778ca3", display: "block", marginBottom: 5 }}>Biografia</label>
                <textarea value={bio} onChange={e => setBio(e.target.value)} placeholder="Escreva algo sobre você..." rows={3} style={{ width: "100%", padding: "11px 14px", borderRadius: 10, border: "1px solid #333", background: "#13151a", color: "#e8eaed", fontSize: 13, outline: "none", resize: "none", lineHeight: 1.5, boxSizing: "border-box" }} />
                <div style={{ fontSize: 10, color: "#556", textAlign: "right", marginTop: 2 }}>{bio.length}/200</div>
              </div>
            </div>
          )}

          {tab === "security" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ background: "#23262e", borderRadius: 12, padding: 16, border: "1px solid #333" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: showPassSection ? 16 : 0 }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 14, color: "#e8eaed" }}>Alterar senha</div>
                    <div style={{ fontSize: 12, color: "#778ca3", marginTop: 2 }}>Atualize sua senha de acesso</div>
                  </div>
                  <button onClick={() => setShowPassSection(!showPassSection)} style={{ background: showPassSection ? "#e2445c20" : "#6c5ce720", color: showPassSection ? "#e2445c" : "#6c5ce7", border: "none", borderRadius: 8, padding: "6px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                    {showPassSection ? "Cancelar" : "Alterar"}
                  </button>
                </div>
                {showPassSection && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <div>
                      <label style={{ fontSize: 11, fontWeight: 600, color: "#778ca3", display: "block", marginBottom: 4 }}>Senha atual</label>
                      <input value={currentPass} onChange={e => setCurrentPass(e.target.value)} type="password" placeholder="••••••" style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid #444", background: "#13151a", color: "#e8eaed", fontSize: 13, outline: "none", boxSizing: "border-box" }} />
                    </div>
                    <div>
                      <label style={{ fontSize: 11, fontWeight: 600, color: "#778ca3", display: "block", marginBottom: 4 }}>Nova senha</label>
                      <input value={newPass} onChange={e => setNewPass(e.target.value)} type="password" placeholder="Mínimo 4 caracteres" style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid #444", background: "#13151a", color: "#e8eaed", fontSize: 13, outline: "none", boxSizing: "border-box" }} />
                    </div>
                    <div>
                      <label style={{ fontSize: 11, fontWeight: 600, color: "#778ca3", display: "block", marginBottom: 4 }}>Confirmar nova senha</label>
                      <input value={confirmPass} onChange={e => setConfirmPass(e.target.value)} type="password" placeholder="Repita a nova senha" style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid #444", background: "#13151a", color: "#e8eaed", fontSize: 13, outline: "none", boxSizing: "border-box" }} />
                      {newPass && confirmPass && newPass !== confirmPass && <div style={{ fontSize: 11, color: "#e2445c", marginTop: 4 }}>As senhas não coincidem</div>}
                      {newPass && confirmPass && newPass === confirmPass && <div style={{ fontSize: 11, color: "#00c875", marginTop: 4 }}>✓ Senhas coincidem</div>}
                    </div>
                  </div>
                )}
              </div>
              <div style={{ background: "#23262e", borderRadius: 12, padding: 16, border: "1px solid #333" }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: "#e8eaed", marginBottom: 4 }}>Informações da conta</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}><span style={{ color: "#778ca3" }}>Cargo</span><RoleBadge role={userData.role} /></div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}><span style={{ color: "#778ca3" }}>Membro desde</span><span style={{ color: "#e8eaed" }}>Mar 2026</span></div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}><span style={{ color: "#778ca3" }}>Último acesso</span><span style={{ color: "#e8eaed" }}>Hoje, {new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</span></div>
                </div>
              </div>
            </div>
          )}

          {tab === "appearance" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#778ca3", display: "block", marginBottom: 10 }}>Cor do avatar</label>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8 }}>
                  {AVATAR_COLORS.map(c => (
                    <div key={c} onClick={() => setAvatarColor(c)} style={{ width: "100%", aspectRatio: "1", borderRadius: 12, background: c, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", border: avatarColor === c ? "3px solid #fff" : "3px solid transparent", transition: "all .15s", boxShadow: avatarColor === c ? `0 0 16px ${c}60` : "none" }}
                      onMouseEnter={e => e.currentTarget.style.transform = "scale(1.1)"} onMouseLeave={e => e.currentTarget.style.transform = "scale(1)"}>
                      {avatarColor === c && <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3"><path d="M20 6L9 17l-5-5"/></svg>}
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ background: "#23262e", borderRadius: 12, padding: 16, border: "1px solid #333" }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#778ca3", marginBottom: 10 }}>Pré-visualização</div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 48, height: 48, borderRadius: 12, background: avatarColor, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 20, fontWeight: 800, boxShadow: `0 4px 12px ${avatarColor}40` }}>{name ? name[0].toUpperCase() : "?"}</div>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 15, color: "#e8eaed" }}>{name}</div>
                    <div style={{ fontSize: 12, color: "#778ca3" }}>{department || "Sem departamento"}</div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: "14px 28px", borderTop: "1px solid #2a2d35", background: "#1a1d23" }}>
          {error && (
            <div style={{ background: "rgba(226,68,92,.08)", border: "1px solid rgba(226,68,92,.2)", borderRadius: 8, padding: "8px 12px", marginBottom: 10, display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#e2445c" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#e2445c" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
              {error}
            </div>
          )}
          {saved && (
            <div style={{ background: "rgba(0,200,117,.08)", border: "1px solid rgba(0,200,117,.2)", borderRadius: 8, padding: "8px 12px", marginBottom: 10, display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#00c875" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#00c875" strokeWidth="2"><path d="M20 6L9 17l-5-5"/></svg>
              Perfil salvo com sucesso!
            </div>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={onClose} style={{ padding: "10px 20px", borderRadius: 10, border: "1px solid #444", background: "transparent", color: "#a5b1c2", fontSize: 13, cursor: "pointer" }}>Cancelar</button>
            <button onClick={handleSave} style={{ padding: "10px 24px", borderRadius: 10, border: "none", background: "linear-gradient(135deg, #6c5ce7, #a55eea)", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", boxShadow: "0 4px 14px rgba(108,92,231,.3)" }}>Salvar alterações</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── LOGIN SCREEN ────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [mode, setMode] = useState("login"); // "login" | "signup"
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [focusName, setFocusName] = useState(false);
  const [focusUser, setFocusUser] = useState(false);
  const [focusPass, setFocusPass] = useState(false);
  const [focusConfirm, setFocusConfirm] = useState(false);
  const isSignup = mode === "signup";

  const handleSubmit = async () => {
    if (isSignup) {
      if (!name.trim() || !username.trim() || !password.trim()) { setError("Preencha todos os campos"); return; }
      if (name.trim().length < 2) { setError("Nome muito curto"); return; }
      if (!USERNAME_RE.test(username.trim())) { setError("Usuário deve ter 3 a 20 caracteres (letras, números, . _ -)"); return; }
      if (password.length < 6) { setError("Senha deve ter pelo menos 6 caracteres"); return; }
      if (password !== confirmPass) { setError("As senhas não coincidem"); return; }
      setLoading(true); setError("");
      try {
        const res = await fetch(`${API_URL}/api/auth/register`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim(), username: username.trim().toLowerCase(), password }),
        });
        const data = await res.json();
        if (!res.ok) { setError(data.error || "Falha ao criar conta"); setLoading(false); return; }
        setToken(data.token);
        onLogin(data.user);
      } catch { setError("Erro de conexão. Tente novamente."); }
      setLoading(false);
      return;
    }
    if (!username.trim() || !password.trim()) { setError("Preencha todos os campos"); return; }
    setLoading(true); setError("");
    try {
      const data = await apiCall("/auth/login", { method: "POST", body: JSON.stringify({ username: username.trim().toLowerCase(), password }) });
      if (data && data.token) {
        setToken(data.token);
        onLogin(data.user);
      } else {
        setError("Usuário ou senha incorretos");
      }
    } catch { setError("Usuário ou senha incorretos"); }
    setLoading(false);
  };

  const switchMode = (next) => {
    setMode(next); setError(""); setName(""); setConfirmPass("");
  };

  return (
    <div style={{ fontFamily: "'DM Sans', 'Segoe UI', system-ui, sans-serif", background: "#0b0d11", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", position: "relative", overflow: "hidden" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />

      {/* Animated background */}
      <div style={{ position: "absolute", inset: 0, overflow: "hidden", opacity: 0.4 }}>
        <div style={{ position: "absolute", width: 500, height: 500, borderRadius: "50%", background: "radial-gradient(circle, #6c5ce740 0%, transparent 70%)", top: "-10%", left: "-10%", animation: "floatA 12s ease-in-out infinite" }} />
        <div style={{ position: "absolute", width: 400, height: 400, borderRadius: "50%", background: "radial-gradient(circle, #e2445c30 0%, transparent 70%)", bottom: "-5%", right: "-5%", animation: "floatB 15s ease-in-out infinite" }} />
        <div style={{ position: "absolute", width: 300, height: 300, borderRadius: "50%", background: "radial-gradient(circle, #579bfc25 0%, transparent 70%)", top: "40%", right: "20%", animation: "floatA 18s ease-in-out infinite reverse" }} />
      </div>

      <div style={{ position: "relative", zIndex: 2, width: 420, maxWidth: "92vw", animation: "fadeUp .6s ease" }}>
        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: 36 }}>
          <div style={{ width: 64, height: 64, borderRadius: 16, background: "linear-gradient(135deg, #6c5ce7, #e2445c)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 28, color: "#fff", boxShadow: "0 8px 32px rgba(108,92,231,.4)", marginBottom: 16 }}>R</div>
          <div style={{ fontWeight: 800, fontSize: 26, color: "#e8eaed", letterSpacing: "-0.5px" }}>Rotina Escritório</div>
          <div style={{ fontSize: 14, color: "#778ca3", marginTop: 4 }}>Gerenciamento inteligente de tarefas</div>
        </div>

        {/* Card */}
        <div style={{ background: "#1a1d23", borderRadius: 20, padding: "36px 32px", border: "1px solid #2a2d35", boxShadow: "0 20px 60px rgba(0,0,0,.5)" }}>
          <div style={{ fontWeight: 700, fontSize: 20, color: "#e8eaed", marginBottom: 4 }}>{isSignup ? "Criar sua conta" : "Bem-vindo de volta"}</div>
          <div style={{ fontSize: 13, color: "#778ca3", marginBottom: 28 }}>{isSignup ? "Cadastre-se para acessar seu espaço de trabalho" : "Faça login para acessar seu espaço de trabalho"}</div>

          {/* Name (signup only) */}
          {isSignup && (
            <div style={{ marginBottom: 18 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: focusName ? "#6c5ce7" : "#778ca3", display: "block", marginBottom: 6, transition: "color .2s" }}>Nome completo</label>
              <div style={{ position: "relative" }}>
                <div style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: focusName ? "#6c5ce7" : "#556" }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                </div>
                <input value={name} onChange={e => { setName(e.target.value); setError(""); }} onFocus={() => setFocusName(true)} onBlur={() => setFocusName(false)} onKeyDown={e => e.key === "Enter" && handleSubmit()}
                  placeholder="Seu nome" type="text"
                  style={{ width: "100%", padding: "13px 14px 13px 42px", borderRadius: 12, border: `2px solid ${focusName ? "#6c5ce7" : error ? "#e2445c" : "#333"}`, background: "#13151a", color: "#e8eaed", fontSize: 14, outline: "none", transition: "border-color .2s", boxSizing: "border-box" }} />
              </div>
            </div>
          )}

          {/* Nome de usuário */}
          <div style={{ marginBottom: 18 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: focusUser ? "#6c5ce7" : "#778ca3", display: "block", marginBottom: 6, transition: "color .2s" }}>Nome de usuário</label>
            <div style={{ position: "relative" }}>
              <div style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: focusUser ? "#6c5ce7" : "#556" }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              </div>
              <input value={username} onChange={e => { setUsername(e.target.value); setError(""); }} onFocus={() => setFocusUser(true)} onBlur={() => setFocusUser(false)} onKeyDown={e => e.key === "Enter" && handleSubmit()}
                placeholder="seu.usuario" type="text" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                style={{ width: "100%", padding: "13px 14px 13px 42px", borderRadius: 12, border: `2px solid ${focusUser ? "#6c5ce7" : error ? "#e2445c" : "#333"}`, background: "#13151a", color: "#e8eaed", fontSize: 14, outline: "none", transition: "border-color .2s", boxSizing: "border-box" }} />
            </div>
          </div>

          {/* Password */}
          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: focusPass ? "#6c5ce7" : "#778ca3", display: "block", marginBottom: 6, transition: "color .2s" }}>Senha</label>
            <div style={{ position: "relative" }}>
              <div style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: focusPass ? "#6c5ce7" : "#556" }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              </div>
              <input value={password} onChange={e => { setPassword(e.target.value); setError(""); }} onFocus={() => setFocusPass(true)} onBlur={() => setFocusPass(false)} onKeyDown={e => e.key === "Enter" && handleSubmit()}
                placeholder="••••••" type={showPass ? "text" : "password"}
                style={{ width: "100%", padding: "13px 44px 13px 42px", borderRadius: 12, border: `2px solid ${focusPass ? "#6c5ce7" : error ? "#e2445c" : "#333"}`, background: "#13151a", color: "#e8eaed", fontSize: 14, outline: "none", transition: "border-color .2s", boxSizing: "border-box" }} />
              <div onClick={() => setShowPass(!showPass)} style={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", cursor: "pointer", color: "#556", fontSize: 13 }}>
                {showPass ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                )}
              </div>
            </div>
          </div>

          {/* Confirm password (signup only) */}
          {isSignup && (
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: focusConfirm ? "#6c5ce7" : "#778ca3", display: "block", marginBottom: 6, transition: "color .2s" }}>Confirmar senha</label>
              <div style={{ position: "relative" }}>
                <div style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: focusConfirm ? "#6c5ce7" : "#556" }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                </div>
                <input value={confirmPass} onChange={e => { setConfirmPass(e.target.value); setError(""); }} onFocus={() => setFocusConfirm(true)} onBlur={() => setFocusConfirm(false)} onKeyDown={e => e.key === "Enter" && handleSubmit()}
                  placeholder="••••••" type={showPass ? "text" : "password"}
                  style={{ width: "100%", padding: "13px 14px 13px 42px", borderRadius: 12, border: `2px solid ${focusConfirm ? "#6c5ce7" : error ? "#e2445c" : "#333"}`, background: "#13151a", color: "#e8eaed", fontSize: 14, outline: "none", transition: "border-color .2s", boxSizing: "border-box" }} />
              </div>
            </div>
          )}

          {/* Forgot / spacer */}
          <div style={{ textAlign: "right", marginBottom: 22, marginTop: isSignup ? 12 : 0 }}>
            {!isSignup && <span style={{ fontSize: 12, color: "#6c5ce7", cursor: "pointer", fontWeight: 500 }}>Esqueceu a senha?</span>}
          </div>

          {/* Error */}
          {error && (
            <div style={{ background: "rgba(226,68,92,.1)", border: "1px solid rgba(226,68,92,.3)", borderRadius: 10, padding: "10px 14px", marginBottom: 16, display: "flex", alignItems: "center", gap: 8, animation: "fadeUp .3s ease" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#e2445c" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
              <span style={{ fontSize: 13, color: "#e2445c", fontWeight: 500 }}>{error}</span>
            </div>
          )}

          {/* Button */}
          <button onClick={handleSubmit} disabled={loading}
            style={{ width: "100%", padding: "14px", borderRadius: 12, border: "none", background: loading ? "#444" : "linear-gradient(135deg, #6c5ce7, #a55eea)", color: "#fff", fontSize: 15, fontWeight: 700, cursor: loading ? "wait" : "pointer", transition: "all .2s", boxShadow: loading ? "none" : "0 4px 20px rgba(108,92,231,.4)", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
            {loading ? (
              <><div style={{ width: 18, height: 18, border: "2px solid rgba(255,255,255,.3)", borderTop: "2px solid #fff", borderRadius: "50%", animation: "spin .6s linear infinite" }} /> {isSignup ? "Criando..." : "Entrando..."}</>
            ) : (isSignup ? "Criar conta" : "Entrar")}
          </button>

          {/* Switch login/signup */}
          <div style={{ textAlign: "center", marginTop: 14 }}>
            {isSignup ? (
              <span style={{ fontSize: 12, color: "#778ca3" }}>Já tem conta? <span onClick={() => switchMode("login")} style={{ color: "#6c5ce7", cursor: "pointer", fontWeight: 600 }}>Entrar</span></span>
            ) : (
              <span style={{ fontSize: 12, color: "#778ca3" }}>Não tem conta? <span onClick={() => switchMode("signup")} style={{ color: "#6c5ce7", cursor: "pointer", fontWeight: 600 }}>Criar conta</span></span>
            )}
          </div>

        </div>

      </div>

      <style>{`
        @keyframes fadeUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes floatA { 0%, 100% { transform: translate(0, 0); } 50% { transform: translate(30px, -30px); } }
        @keyframes floatB { 0%, 100% { transform: translate(0, 0); } 50% { transform: translate(-20px, 20px); } }
        @keyframes spin { to { transform: rotate(360deg); } }
        * { box-sizing: border-box; }
        ::placeholder { color: #556; }
      `}</style>
    </div>
  );
}

// ─── SYNC INDICATOR ──────────────────────────────────────────────────────────
function useSyncStatus() {
  const [status, setStatus] = useState(() => getSyncStatus());
  useEffect(() => {
    const update = () => setStatus(getSyncStatus());
    const unsub = subscribeSyncStatus(update);
    const onOnline = () => { _isOnline = true; _notifySync(); };
    const onOffline = () => { _isOnline = false; _notifySync(); };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => { unsub(); window.removeEventListener("online", onOnline); window.removeEventListener("offline", onOffline); };
  }, []);
  return status;
}

function SyncIndicator() {
  const { state, inFlight, failed } = useSyncStatus();
  const cfg = {
    idle:    { color: "#00c875", bg: "rgba(0,200,117,.1)",  border: "rgba(0,200,117,.3)" },
    saving:  { color: "#fdab3d", bg: "rgba(253,171,61,.12)", border: "rgba(253,171,61,.35)" },
    offline: { color: "#e2445c", bg: "rgba(226,68,92,.12)",  border: "rgba(226,68,92,.4)"  },
    error:   { color: "#e2445c", bg: "rgba(226,68,92,.12)",  border: "rgba(226,68,92,.4)"  },
  }[state];
  const label =
    state === "idle"    ? "Salvo"
    : state === "saving" ? (inFlight > 1 ? `Salvando (${inFlight})...` : "Salvando...")
    : state === "offline" ? "Sem conexão"
    : `${failed} não salvo${failed > 1 ? "s" : ""}`;
  const tip =
    state === "idle"    ? "Tudo sincronizado com o servidor."
    : state === "saving" ? "Enviando suas alterações..."
    : state === "offline" ? "Você está sem conexão. Suas alterações podem não ser salvas — aguarde a conexão voltar antes de continuar."
    : `${failed} alteração(ões) não foram salvas no servidor. Tente repetir a ação. Se persistir, recarregue a página.`;
  const Icon = () => {
    if (state === "saving") return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={cfg.color} strokeWidth="2.5" strokeLinecap="round" style={{ animation: "syncSpin 1s linear infinite" }}>
        <path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" />
      </svg>
    );
    if (state === "offline") return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={cfg.color} strokeWidth="2.5" strokeLinecap="round">
        <path d="M1 1l22 22" /><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" /><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" /><path d="M10.71 5.05A16 16 0 0 1 22.58 9" /><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" /><path d="M8.53 16.11a6 6 0 0 1 6.95 0" /><circle cx="12" cy="20" r="1" />
      </svg>
    );
    if (state === "error") return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={cfg.color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    );
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={cfg.color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    );
  };
  return (
    <div title={tip} onClick={state === "error" ? () => clearSyncFailed() : undefined} style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 9px", borderRadius: 14, background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.color, fontSize: 11, fontWeight: 600, cursor: state === "error" ? "pointer" : "default", userSelect: "none", transition: "background .15s, border-color .15s" }}>
      <Icon />
      <span>{label}</span>
    </div>
  );
}

// ─── BOARDS SIDEBAR ──────────────────────────────────────────────────────────
function BoardsSidebar({ folders, boards, currentBoardId, onSelectBoard, onNewBoard, onNewFolder, onRenameBoard, onRenameFolder, onDeleteBoard, onDeleteFolder, onManageAccess, isAdmin, collapsed, onToggleCollapsed, collapsedFolders, onToggleFolder }) {
  if (collapsed) {
    return (
      <div style={{ width: 38, background: "#1a1d23", borderRight: "1px solid #2a2d35", display: "flex", flexDirection: "column", alignItems: "center", padding: "10px 0", flexShrink: 0 }}>
        <button onClick={onToggleCollapsed} title="Expandir" style={{ background: "transparent", border: "none", color: "#778ca3", fontSize: 18, cursor: "pointer", padding: 6 }}>☰</button>
      </div>
    );
  }
  return (
    <div style={{ width: 220, background: "#1a1d23", borderRight: "1px solid #2a2d35", display: "flex", flexDirection: "column", flexShrink: 0, overflow: "hidden" }}>
      <div style={{ padding: "10px 12px", borderBottom: "1px solid #2a2d35", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <span style={{ fontWeight: 700, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5, color: "#e8eaed" }}>Quadros</span>
        <button onClick={onToggleCollapsed} title="Recolher" style={{ background: "transparent", border: "none", color: "#778ca3", fontSize: 14, cursor: "pointer", padding: 2 }}>«</button>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: "6px 0" }}>
        {folders.map(folder => {
          const folderBoards = boards.filter(b => b.folderId === folder.id);
          const isOpen = !collapsedFolders[folder.id];
          return (
            <div key={folder.id} style={{ marginBottom: 2 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", cursor: "pointer", color: "#c8cdd4", fontSize: 12, fontWeight: 700, userSelect: "none", group: "folder" }}
                onClick={() => onToggleFolder(folder.id)}>
                <span style={{ fontSize: 9, color: "#778ca3", width: 8, display: "inline-block", transform: isOpen ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▶</span>
                <span style={{ fontSize: 13 }}>{folder.icon}</span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{folder.name}</span>
                {isAdmin && (
                  <span style={{ display: "flex", gap: 2, opacity: 0.7 }} onClick={e => e.stopPropagation()}>
                    <button title="Novo quadro nesta pasta" onClick={() => onNewBoard(folder.id)} style={{ background: "transparent", border: "none", color: "#6c5ce7", cursor: "pointer", fontSize: 13, padding: 0, lineHeight: 1 }}>+</button>
                    <button title="Renomear pasta" onClick={() => onRenameFolder(folder)} style={{ background: "transparent", border: "none", color: "#778ca3", cursor: "pointer", fontSize: 11, padding: 0, lineHeight: 1 }}>✎</button>
                    <button title="Excluir pasta" onClick={() => onDeleteFolder(folder)} style={{ background: "transparent", border: "none", color: "#e2445c", cursor: "pointer", fontSize: 11, padding: 0, lineHeight: 1 }}>🗑</button>
                  </span>
                )}
              </div>
              {isOpen && (
                <div>
                  {folderBoards.length === 0 && (
                    <div style={{ padding: "4px 10px 4px 30px", fontSize: 11, color: "#556" }}>— vazia —</div>
                  )}
                  {folderBoards.map(b => {
                    const active = b.id === currentBoardId;
                    return (
                      <div key={b.id} onClick={() => onSelectBoard(b.id)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px 5px 28px", cursor: "pointer", background: active ? "rgba(108,92,231,.15)" : "transparent", borderLeft: active ? "3px solid #6c5ce7" : "3px solid transparent", color: active ? "#fff" : "#c8cdd4", fontSize: 12 }}
                        onMouseEnter={e => { if (!active) e.currentTarget.style.background = "rgba(255,255,255,.03)"; }}
                        onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent"; }}>
                        <span style={{ fontSize: 12 }}>{b.icon}</span>
                        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name}</span>
                        {isAdmin && (
                          <span style={{ display: "flex", gap: 2, opacity: 0.5 }} onClick={e => e.stopPropagation()}>
                            <button title="Gerenciar acesso ao quadro" onClick={() => onManageAccess(b)} style={{ background: "transparent", border: "none", color: "#778ca3", cursor: "pointer", fontSize: 11, padding: 0, lineHeight: 1 }}>👥</button>
                            <button title="Renomear" onClick={() => onRenameBoard(b)} style={{ background: "transparent", border: "none", color: "#778ca3", cursor: "pointer", fontSize: 10, padding: 0, lineHeight: 1 }}>✎</button>
                            <button title="Excluir" onClick={() => onDeleteBoard(b)} style={{ background: "transparent", border: "none", color: "#e2445c", cursor: "pointer", fontSize: 10, padding: 0, lineHeight: 1 }}>🗑</button>
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {isAdmin && (
        <div style={{ padding: 8, borderTop: "1px solid #2a2d35", display: "flex", gap: 6, flexShrink: 0 }}>
          <button onClick={() => onNewBoard(null)} style={{ flex: 1, background: "#6c5ce7", color: "#fff", border: "none", borderRadius: 6, padding: "6px 8px", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>+ Quadro</button>
          <button onClick={onNewFolder} title="Nova pasta" style={{ background: "transparent", color: "#c8cdd4", border: "1px solid #2a2d35", borderRadius: 6, padding: "6px 8px", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>📁+</button>
        </div>
      )}
    </div>
  );
}

// ─── BOARD ACCESS MODAL ──────────────────────────────────────────────────────
// Acesso explícito ao quadro, sem depender de eleger a pessoa em alguma tarefa.
function BoardAccessModal({ board, onClose }) {
  const [rows, setRows] = useState(null);
  const [checked, setChecked] = useState({});
  const [restrito, setRestrito] = useState(!!board.restricted);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      const data = await apiCall(`/boards/${board.id}/members`);
      if (!alive) return;
      if (!data || !Array.isArray(data.users)) { setErr("Não foi possível carregar a lista de usuários."); setRows([]); return; }
      setRows(data.users);
      setRestrito(!!data.restricted);
      setChecked(Object.fromEntries(data.users.map(u => [u.id, !!u.member])));
    })();
    return () => { alive = false; };
  }, [board.id]);

  // Com o quadro restrito, quem só entrava por ser responsável perde o acesso.
  const perdemAcesso = (rows || []).filter(u => u.role !== "admin" && u.viaTask && !checked[u.id]);

  const save = async () => {
    setSaving(true); setErr("");
    const userIds = Object.entries(checked).filter(([, v]) => v).map(([k]) => Number(k));
    const r1 = await apiCall(`/boards/${board.id}/members`, { method: "PUT", body: JSON.stringify({ userIds }), returnError: true });
    if (r1?.error) { setSaving(false); setErr(r1.error); return; }
    const r2 = await apiCall(`/boards/${board.id}`, { method: "PUT", body: JSON.stringify({ restricted: restrito }), returnError: true });
    setSaving(false);
    if (r2?.error) { setErr(r2.error); return; }
    onClose(true);
  };

  const linha = (u) => {
    const on = !!checked[u.id];
    const isAdmin = u.role === "admin";
    return (
      <div key={u.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 8, background: on ? "rgba(108,92,231,.10)" : "transparent", marginBottom: 3 }}>
        <input type="checkbox" checked={isAdmin ? true : on} disabled={isAdmin}
          onChange={() => setChecked(p => ({ ...p, [u.id]: !p[u.id] }))}
          style={{ accentColor: "#6c5ce7", width: 15, height: 15, cursor: isAdmin ? "not-allowed" : "pointer" }} />
        <Avatar name={u.name} size={26} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, color: "#e8eaed", fontWeight: 600 }}>{u.name}</div>
          <div style={{ fontSize: 11, color: "#778ca3" }}>@{u.username}</div>
          {!isAdmin && u.viaTask && (
            // Aponta o vínculo exato: é aqui que se descobre por que alguém
            // enxerga o quadro sem ter sido liberado de propósito.
            <div style={{ fontSize: 10.5, color: restrito ? "#667" : "#fdab3d", marginTop: 3, lineHeight: 1.4, textDecoration: restrito ? "line-through" : "none" }}>
              {restrito ? "Responsável em: " : "Enxerga por: "}{(u.where || []).slice(0, 3).join("; ")}{(u.where || []).length > 3 ? ` … +${u.where.length - 3}` : ""}
            </div>
          )}
        </div>
        {isAdmin && <span title="Administradores enxergam todos os quadros, independente desta lista" style={{ fontSize: 10, color: "#e2445c", border: "1px solid rgba(226,68,92,.4)", borderRadius: 10, padding: "2px 7px", flexShrink: 0 }}>admin — vê tudo</span>}
        {!isAdmin && u.viaTask && <span title={(u.where || []).join("\n")} style={{ fontSize: 10, color: "#fdab3d", border: "1px solid rgba(253,171,61,.4)", borderRadius: 10, padding: "2px 7px", flexShrink: 0 }}>responsável</span>}
      </div>
    );
  };

  return (
    <div onClick={() => onClose(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#23262e", borderRadius: 14, width: 480, maxWidth: "92vw", maxHeight: "86vh", display: "flex", flexDirection: "column", border: "1px solid #3a3d45", boxShadow: "0 18px 50px rgba(0,0,0,.6)" }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid #3a3d45" }}>
          <div style={{ fontWeight: 700, fontSize: 16, color: "#e8eaed" }}>Acesso ao quadro</div>
          <div style={{ fontSize: 12, color: "#778ca3", marginTop: 3 }}>{board.icon} {board.name}</div>
        </div>

        <div style={{ padding: "10px 14px", flex: 1, overflow: "auto" }}>
          <div style={{ fontSize: 11.5, color: "#a5b1c2", lineHeight: 1.5, marginBottom: 10 }}>
            Marque quem pode ver este quadro. O acesso vale por si só — não é preciso colocar a pessoa como responsável em nenhuma tarefa.
          </div>

          {/* Sem isto ligado, ser responsável por uma tarefa daqui continua
              abrindo o quadro, mesmo para quem não está marcado acima. */}
          <div style={{ background: "#1a1d23", border: `1px solid ${restrito ? "#6c5ce7" : "#333"}`, borderRadius: 9, padding: "10px 12px", marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div onClick={() => setRestrito(v => !v)} style={{ width: 38, height: 20, borderRadius: 10, background: restrito ? "#6c5ce7" : "#444", cursor: "pointer", position: "relative", flexShrink: 0 }}>
                <div style={{ width: 16, height: 16, borderRadius: "50%", background: "#fff", position: "absolute", top: 2, left: restrito ? 20 : 2, transition: "left .2s" }} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: "#e8eaed" }}>Somente quem está marcado vê este quadro</div>
                <div style={{ fontSize: 11, color: "#778ca3", marginTop: 2 }}>
                  {restrito
                    ? "Ser responsável por uma tarefa daqui não dá mais acesso."
                    : "Desligado: quem é responsável por qualquer tarefa ou subitem daqui também enxerga o quadro."}
                </div>
              </div>
            </div>
            {restrito && perdemAcesso.length > 0 && (
              <div style={{ marginTop: 9, paddingTop: 9, borderTop: "1px solid #333", fontSize: 11, color: "#fdab3d", lineHeight: 1.5 }}>
                ⚠ Ao salvar, {perdemAcesso.length === 1 ? "esta pessoa perde" : "estas pessoas perdem"} o acesso: {perdemAcesso.map(u => u.name).join(", ")}. Marque quem deve continuar entrando.
              </div>
            )}
          </div>
          {rows === null && <div style={{ padding: 20, textAlign: "center", color: "#778ca3", fontSize: 13 }}>Carregando...</div>}
          {rows && rows.length === 0 && !err && <div style={{ padding: 20, textAlign: "center", color: "#778ca3", fontSize: 13 }}>Nenhum usuário cadastrado.</div>}
          {rows && rows.map(linha)}
        </div>

        {err && <div style={{ padding: "8px 20px", color: "#e2445c", fontSize: 12 }}>{err}</div>}

        <div style={{ padding: "12px 16px", borderTop: "1px solid #3a3d45", display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={() => onClose(false)} style={{ background: "transparent", border: "1px solid #444", color: "#c8cdd4", borderRadius: 8, padding: "8px 16px", fontSize: 12.5, cursor: "pointer" }}>Cancelar</button>
          <button onClick={save} disabled={saving || rows === null} style={{ background: "#6c5ce7", border: "none", color: "#fff", borderRadius: 8, padding: "8px 18px", fontSize: 12.5, fontWeight: 600, cursor: saving ? "default" : "pointer", opacity: saving || rows === null ? 0.6 : 1 }}>
            {saving ? "Salvando..." : "Salvar acesso"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── NEW BOARD MODAL ─────────────────────────────────────────────────────────
function NewBoardModal({ folders, boards, defaultFolderId, defaultMode, onClose, onCreate }) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("📋");
  const [folderId, setFolderId] = useState(defaultFolderId || folders[0]?.id || "");
  const [mode, setMode] = useState(defaultMode || "blank"); // 'blank' | 'copy'
  const [copyFromId, setCopyFromId] = useState(boards[0]?.id || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async () => {
    if (!name.trim()) { setErr("Informe um nome"); return; }
    if (!folderId) { setErr("Escolha uma pasta"); return; }
    setBusy(true); setErr("");
    const payload = { name: name.trim(), icon, folderId };
    if (mode === "copy") payload.copyFromId = copyFromId;
    const res = await onCreate(payload);
    setBusy(false);
    if (res?.error) { setErr(res.error); return; }
    onClose();
  };
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#1a1d23", borderRadius: 12, padding: 22, width: 460, maxWidth: "92vw", border: "1px solid #2a2d35" }}>
        <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 16, color: "#e8eaed" }}>Novo quadro</div>

        <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 11, color: "#778ca3", fontWeight: 600 }}>Nome</label>
            <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Ex: Vendas, RH..." style={{ width: "100%", marginTop: 4, padding: "8px 10px", borderRadius: 6, border: "1px solid #2a2d35", background: "#13151a", color: "#e8eaed", fontSize: 13, outline: "none" }} />
          </div>
          <div style={{ width: 70 }}>
            <label style={{ fontSize: 11, color: "#778ca3", fontWeight: 600 }}>Ícone</label>
            <input value={icon} onChange={e => setIcon(e.target.value.slice(0, 2))} style={{ width: "100%", marginTop: 4, padding: "8px 10px", borderRadius: 6, border: "1px solid #2a2d35", background: "#13151a", color: "#e8eaed", fontSize: 16, outline: "none", textAlign: "center" }} />
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 11, color: "#778ca3", fontWeight: 600 }}>Pasta</label>
          <select value={folderId} onChange={e => setFolderId(e.target.value)} style={{ width: "100%", marginTop: 4, padding: "8px 10px", borderRadius: 6, border: "1px solid #2a2d35", background: "#13151a", color: "#e8eaed", fontSize: 13, outline: "none" }}>
            {folders.map(f => <option key={f.id} value={f.id}>{f.icon} {f.name}</option>)}
          </select>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 11, color: "#778ca3", fontWeight: 600, display: "block", marginBottom: 6 }}>Modelo</label>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setMode("blank")} style={{ flex: 1, padding: "10px 8px", border: mode === "blank" ? "2px solid #6c5ce7" : "1px solid #2a2d35", borderRadius: 6, background: mode === "blank" ? "rgba(108,92,231,.1)" : "#13151a", color: "#e8eaed", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>📄 Em branco</button>
            <button onClick={() => setMode("copy")} disabled={boards.length === 0} style={{ flex: 1, padding: "10px 8px", border: mode === "copy" ? "2px solid #6c5ce7" : "1px solid #2a2d35", borderRadius: 6, background: mode === "copy" ? "rgba(108,92,231,.1)" : "#13151a", color: boards.length === 0 ? "#444" : "#e8eaed", fontSize: 12, fontWeight: 600, cursor: boards.length === 0 ? "not-allowed" : "pointer" }}>📋 Copiar de…</button>
          </div>
        </div>

        {mode === "copy" && (
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 11, color: "#778ca3", fontWeight: 600 }}>Copiar estrutura de</label>
            <select value={copyFromId} onChange={e => setCopyFromId(e.target.value)} style={{ width: "100%", marginTop: 4, padding: "8px 10px", borderRadius: 6, border: "1px solid #2a2d35", background: "#13151a", color: "#e8eaed", fontSize: 13, outline: "none" }}>
              {boards.map(b => <option key={b.id} value={b.id}>{b.icon} {b.name}</option>)}
            </select>
            <div style={{ fontSize: 10, color: "#778ca3", marginTop: 4 }}>Apenas colunas serão copiadas. Tarefas e relatórios não.</div>
          </div>
        )}

        {err && <div style={{ color: "#e2445c", fontSize: 11, marginBottom: 8 }}>{err}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} disabled={busy} style={{ background: "transparent", color: "#c8cdd4", border: "1px solid #2a2d35", borderRadius: 6, padding: "8px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Cancelar</button>
          <button onClick={submit} disabled={busy} style={{ background: "#6c5ce7", color: "#fff", border: "none", borderRadius: 6, padding: "8px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", opacity: busy ? 0.6 : 1 }}>{busy ? "Criando..." : "Criar"}</button>
        </div>
      </div>
    </div>
  );
}

// ─── NEW FOLDER MODAL ────────────────────────────────────────────────────────
function NewFolderModal({ onClose, onCreate, target }) {
  const editing = !!target;
  const [name, setName] = useState(target?.name || "");
  const [icon, setIcon] = useState(target?.icon || "📁");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async () => {
    if (!name.trim()) { setErr("Informe um nome"); return; }
    setBusy(true); setErr("");
    const res = await onCreate({ name: name.trim(), icon });
    setBusy(false);
    if (res?.error) { setErr(res.error); return; }
    onClose();
  };
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#1a1d23", borderRadius: 12, padding: 22, width: 380, maxWidth: "92vw", border: "1px solid #2a2d35" }}>
        <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 16, color: "#e8eaed" }}>{editing ? "Renomear pasta" : "Nova pasta"}</div>
        <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 11, color: "#778ca3", fontWeight: 600 }}>Nome</label>
            <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Ex: Marketing" style={{ width: "100%", marginTop: 4, padding: "8px 10px", borderRadius: 6, border: "1px solid #2a2d35", background: "#13151a", color: "#e8eaed", fontSize: 13, outline: "none" }} />
          </div>
          <div style={{ width: 70 }}>
            <label style={{ fontSize: 11, color: "#778ca3", fontWeight: 600 }}>Ícone</label>
            <input value={icon} onChange={e => setIcon(e.target.value.slice(0, 2))} style={{ width: "100%", marginTop: 4, padding: "8px 10px", borderRadius: 6, border: "1px solid #2a2d35", background: "#13151a", color: "#e8eaed", fontSize: 16, outline: "none", textAlign: "center" }} />
          </div>
        </div>
        {err && <div style={{ color: "#e2445c", fontSize: 11, marginBottom: 8 }}>{err}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} disabled={busy} style={{ background: "transparent", color: "#c8cdd4", border: "1px solid #2a2d35", borderRadius: 6, padding: "8px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Cancelar</button>
          <button onClick={submit} disabled={busy} style={{ background: "#6c5ce7", color: "#fff", border: "none", borderRadius: 6, padding: "8px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", opacity: busy ? 0.6 : 1 }}>{busy ? "Salvando..." : (editing ? "Salvar" : "Criar")}</button>
        </div>
      </div>
    </div>
  );
}

// ─── RENAME BOARD MODAL ──────────────────────────────────────────────────────
function RenameBoardModal({ target, onClose, onSave }) {
  const [name, setName] = useState(target.name);
  const [icon, setIcon] = useState(target.icon);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async () => {
    if (!name.trim()) { setErr("Informe um nome"); return; }
    setBusy(true); setErr("");
    const res = await onSave({ name: name.trim(), icon });
    setBusy(false);
    if (res?.error) { setErr(res.error); return; }
    onClose();
  };
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#1a1d23", borderRadius: 12, padding: 22, width: 380, maxWidth: "92vw", border: "1px solid #2a2d35" }}>
        <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 16, color: "#e8eaed" }}>Renomear quadro</div>
        <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 11, color: "#778ca3", fontWeight: 600 }}>Nome</label>
            <input autoFocus value={name} onChange={e => setName(e.target.value)} style={{ width: "100%", marginTop: 4, padding: "8px 10px", borderRadius: 6, border: "1px solid #2a2d35", background: "#13151a", color: "#e8eaed", fontSize: 13, outline: "none" }} />
          </div>
          <div style={{ width: 70 }}>
            <label style={{ fontSize: 11, color: "#778ca3", fontWeight: 600 }}>Ícone</label>
            <input value={icon} onChange={e => setIcon(e.target.value.slice(0, 2))} style={{ width: "100%", marginTop: 4, padding: "8px 10px", borderRadius: 6, border: "1px solid #2a2d35", background: "#13151a", color: "#e8eaed", fontSize: 16, outline: "none", textAlign: "center" }} />
          </div>
        </div>
        {err && <div style={{ color: "#e2445c", fontSize: 11, marginBottom: 8 }}>{err}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} disabled={busy} style={{ background: "transparent", color: "#c8cdd4", border: "1px solid #2a2d35", borderRadius: 6, padding: "8px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Cancelar</button>
          <button onClick={submit} disabled={busy} style={{ background: "#6c5ce7", color: "#fff", border: "none", borderRadius: 6, padding: "8px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", opacity: busy ? 0.6 : 1 }}>{busy ? "Salvando..." : "Salvar"}</button>
        </div>
      </div>
    </div>
  );
}

// ─── CREATE USER MODAL (admin) ───────────────────────────────────────────────
function CreateUserModal({ onClose, onCreate }) {
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("collaborator");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState(false);
  const submit = async () => {
    if (!name.trim() || !username.trim() || !password) { setErr("Preencha todos os campos"); return; }
    if (!USERNAME_RE.test(username.trim())) { setErr("Usuário deve ter 3 a 20 caracteres (letras, números, . _ -)"); return; }
    if (password.length < 4) { setErr("Senha deve ter pelo menos 4 caracteres"); return; }
    setBusy(true); setErr("");
    try {
      const res = await onCreate({ name: name.trim(), username: username.trim().toLowerCase(), password, role });
      if (res?.error) { setErr(res.error); return; }
      setOk(true);
      setTimeout(() => onClose(), 900);
    } catch (e) {
      setErr("Erro inesperado: " + (e?.message || "tente novamente"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, backdropFilter: "blur(4px)" }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#1a1d23", borderRadius: 14, padding: 26, width: 420, maxWidth: "92vw", border: "1px solid #2a2d35" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#00c875" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
          <div style={{ fontWeight: 700, fontSize: 16, color: "#e8eaed" }}>Cadastrar usuário</div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 11, color: "#778ca3", fontWeight: 600, display: "block", marginBottom: 4 }}>Nome</label>
          <input autoFocus value={name} onChange={e => { setName(e.target.value); setErr(""); }} placeholder="Nome completo"
            style={{ width: "100%", padding: "9px 11px", borderRadius: 7, border: "1px solid #2a2d35", background: "#13151a", color: "#e8eaed", fontSize: 13, outline: "none", boxSizing: "border-box" }} />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 11, color: "#778ca3", fontWeight: 600, display: "block", marginBottom: 4 }}>Nome de usuário</label>
          <input value={username} onChange={e => { setUsername(e.target.value); setErr(""); }} placeholder="nome.de.usuario" type="text" autoCapitalize="none" spellCheck={false}
            style={{ width: "100%", padding: "9px 11px", borderRadius: 7, border: "1px solid #2a2d35", background: "#13151a", color: "#e8eaed", fontSize: 13, outline: "none", boxSizing: "border-box" }} />
          <div style={{ fontSize: 10, color: "#778ca3", marginTop: 4 }}>É com ele que o usuário entra no sistema.</div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 11, color: "#778ca3", fontWeight: 600, display: "block", marginBottom: 4 }}>Senha provisória</label>
          <input value={password} onChange={e => { setPassword(e.target.value); setErr(""); }} placeholder="Mínimo 4 caracteres" type="password"
            style={{ width: "100%", padding: "9px 11px", borderRadius: 7, border: "1px solid #2a2d35", background: "#13151a", color: "#e8eaed", fontSize: 13, outline: "none", boxSizing: "border-box" }} />
          <div style={{ fontSize: 10, color: "#778ca3", marginTop: 4 }}>O usuário poderá trocar depois em Editar perfil.</div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 11, color: "#778ca3", fontWeight: 600, display: "block", marginBottom: 4 }}>Cargo</label>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setRole("collaborator")} style={{ flex: 1, padding: "9px 8px", border: role === "collaborator" ? "2px solid #579bfc" : "1px solid #2a2d35", borderRadius: 7, background: role === "collaborator" ? "rgba(87,155,252,.1)" : "#13151a", color: "#e8eaed", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>👤 Colaborador</button>
            <button onClick={() => setRole("admin")} style={{ flex: 1, padding: "9px 8px", border: role === "admin" ? "2px solid #e2445c" : "1px solid #2a2d35", borderRadius: 7, background: role === "admin" ? "rgba(226,68,92,.1)" : "#13151a", color: "#e8eaed", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>👑 Administrador</button>
          </div>
        </div>

        {err && <div style={{ color: "#e2445c", fontSize: 12, marginBottom: 10, background: "rgba(226,68,92,.08)", padding: "8px 10px", borderRadius: 6 }}>⚠ {err}</div>}
        {ok && <div style={{ color: "#00c875", fontSize: 12, marginBottom: 10, background: "rgba(0,200,117,.08)", padding: "8px 10px", borderRadius: 6 }}>✓ Usuário cadastrado!</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} disabled={busy} style={{ background: "transparent", color: "#c8cdd4", border: "1px solid #2a2d35", borderRadius: 7, padding: "9px 16px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Cancelar</button>
          <button onClick={submit} disabled={busy || ok} style={{ background: ok ? "#00c875" : "#6c5ce7", color: "#fff", border: "none", borderRadius: 7, padding: "9px 16px", fontSize: 12, fontWeight: 600, cursor: "pointer", opacity: busy ? 0.6 : 1 }}>{busy ? "Cadastrando..." : (ok ? "✓" : "Cadastrar")}</button>
        </div>
      </div>
    </div>
  );
}

// ─── MAIN APP ────────────────────────────────────────────────────────────────
function Dashboard({ currentUser, onLogout }) {
  const [tasks, setTasks] = useState([]);
  const [columns, setColumns] = useState(INITIAL_COLUMNS);
  const [view, setView] = useState("board");
  const [search, setSearch] = useState("");
  const [showAI, setShowAI] = useState(false);
  const [showAddTask, setShowAddTask] = useState(false);
  const [showAddCol, setShowAddCol] = useState(false);
  const [showAddSubCol, setShowAddSubCol] = useState(false);
  const [activeSubColTaskId, setActiveSubColTaskId] = useState(null);
  const [subColumns, setSubColumns] = useState([]);
  const [automations, setAutomations] = useState([]);
  const [updatesTarget, setUpdatesTarget] = useState(null);
  const [showNotifs, setShowNotifs] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showDrive, setShowDrive] = useState(false);
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [showReports, setShowReports] = useState(false);
  const [reportsFullscreen, setReportsFullscreen] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [users, setUsers] = useState([]);
  const [dataLoaded, setDataLoaded] = useState(false);
  // Multi-board / folders
  const [folders, setFolders] = useState([]);
  const [boards, setBoards] = useState([]);
  const [currentBoardId, setCurrentBoardId] = useState(() => localStorage.getItem("rotina_board") || "board_operacoes");
  const [collapsedFolders, setCollapsedFolders] = useState({});
  const [showNewBoard, setShowNewBoard] = useState(false);
  const [newBoardFolderId, setNewBoardFolderId] = useState(null);
  const [newBoardMode, setNewBoardMode] = useState("blank");
  const [showBoardPicker, setShowBoardPicker] = useState(false);
  const boardPickerRef = useRef(null);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [renameBoardTarget, setRenameBoardTarget] = useState(null);
  const [accessBoardTarget, setAccessBoardTarget] = useState(null);
  const [renameFolderTarget, setRenameFolderTarget] = useState(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("rotina_sidebar_collapsed") === "1");
  const notifRef = useRef(null);
  const userMenuRef = useRef(null);
  useClickOutside(notifRef, () => setShowNotifs(false));
  useClickOutside(userMenuRef, () => setShowUserMenu(false));
  useClickOutside(boardPickerRef, () => setShowBoardPicker(false));

  const normalizeTasks = (data) => data.map(t => ({ ...t, custom: t.custom || {}, updates: t.updates || [], subitems: (t.subitems || []).map(s => ({ ...s, custom: s.custom || {}, updates: s.updates || [], cancellations: s.cancellations || 0 })) }));

  // ─── LOAD ALL DATA FROM API ON MOUNT ───────────────────────────────────────
  useEffect(() => {
    let mounted = true;
    async function loadData() {
      const [foldersData, boardsData, usersData, autoData] = await Promise.all([
        apiCall("/folders"), apiCall("/boards"), apiCall("/users"), apiCall("/automations"),
      ]);
      if (!mounted) return;
      const folderList = foldersData || [];
      const boardList = boardsData || [];
      setFolders(folderList);
      setBoards(boardList);

      // No accessible boards (non-admin without any responsibility): bail out
      // here so we don't fire 403s for /tasks and /columns.
      if (boardList.length === 0) {
        setCurrentBoardId(null);
        setTasks([]); setColumns([]); setSubColumns([]);
        if (usersData) setUsers(usersData.map(u => ({ ...u, password: "******" })));
        if (autoData) setAutomations(autoData);
        setDataLoaded(true);
        return;
      }

      // Resolve active board: stored choice if it still exists, else first board.
      const stored = localStorage.getItem("rotina_board");
      const initialBoardId = (boardList.find(b => b.id === stored)?.id) || boardList[0].id;
      setCurrentBoardId(initialBoardId);

      const [tasksData, colsData] = await Promise.all([
        apiCall(`/tasks?boardId=${encodeURIComponent(initialBoardId)}`),
        apiCall(`/columns?boardId=${encodeURIComponent(initialBoardId)}`),
      ]);
      if (!mounted) return;
      // Ordena ao abrir o quadro; daí em diante a ordem fica congelada.
      if (tasksData) setTasks(sortTaskTree(normalizeTasks(tasksData)));
      else setTasks([]);
      if (colsData) {
        setColumns(colsData.filter(c => (c.scope || 'task') === 'task'));
        setSubColumns(colsData.filter(c => c.scope === 'subitem'));
      }
      if (usersData) setUsers(usersData.map(u => ({ ...u, password: "******" })));
      // No fallback to hardcoded REGISTERED_USERS: that would resurrect deleted users
      // in the picker. If the API failed, stay empty until next successful fetch.
      if (autoData) setAutomations(autoData);
      else setAutomations(AI_AUTOMATIONS);
      setDataLoaded(true);
    }
    loadData();
    return () => { mounted = false; };
  }, []);

  // ─── SWITCH BOARD: refetch tasks/columns scoped to the new board ──────────
  const switchBoard = async (boardId) => {
    if (!boardId || boardId === currentBoardId) return;
    setCurrentBoardId(boardId);
    localStorage.setItem("rotina_board", boardId);
    const [tasksData, colsData] = await Promise.all([
      apiCall(`/tasks?boardId=${encodeURIComponent(boardId)}`),
      apiCall(`/columns?boardId=${encodeURIComponent(boardId)}`),
    ]);
    if (tasksData) setTasks(sortTaskTree(normalizeTasks(tasksData))); else setTasks([]);
    if (colsData) {
      setColumns(colsData.filter(c => (c.scope || 'task') === 'task'));
      setSubColumns(colsData.filter(c => c.scope === 'subitem'));
    } else {
      setColumns([]); setSubColumns([]);
    }
  };

  // ─── POLLING: sincronização automática entre clientes ─────────────────────
  // Marca que o próximo `tasks` veio do servidor: só assim o detector de
  // alterações alerta (edição local do próprio usuário não deve alarmar).
  const pollAppliedRef = useRef(false);
  useEffect(() => {
    if (!dataLoaded) return;
    const POLL_MS = 4000;
    // Com a aba em segundo plano continuamos sincronizando (é o poll que dispara
    // o som de notificação), só que num intervalo maior para poupar o servidor.
    const HIDDEN_POLL_MS = 12000;
    let cancelled = false;
    let lastFetch = 0;
    const isUserEditing = () => {
      const ae = document.activeElement;
      if (!ae) return false;
      const tag = ae.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || ae.isContentEditable;
    };
    const tick = async () => {
      if (cancelled) return;
      if (!currentBoardId) return;
      const minGap = document.hidden ? HIDDEN_POLL_MS : POLL_MS;
      if (Date.now() - lastFetch < minGap - 250) return;
      if (isUserEditing()) return;
      if (hasInFlightMutations()) return;
      lastFetch = Date.now();
      const data = await apiCall(`/tasks?boardId=${encodeURIComponent(currentBoardId)}`);
      if (cancelled || !data) return;
      if (isUserEditing() || hasInFlightMutations()) return;
      pollAppliedRef.current = true;
      // O poll adota a ordem que já está na tela em vez de impor a do servidor:
      // assim a alteração de status de um colega não embaralha o quadro de quem
      // está trabalhando. A reorganização chega pela reordenação ociosa.
      setTasks(prev => keepTaskTreeOrder(normalizeTasks(data), prev));
    };
    const id = setInterval(tick, POLL_MS);
    // Ao voltar para a aba, sincroniza na hora em vez de esperar o próximo tick.
    const onVisibility = () => { if (!document.hidden) tick(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { cancelled = true; clearInterval(id); document.removeEventListener("visibilitychange", onVisibility); };
  }, [dataLoaded, currentBoardId]);

  // ─── POLLING: lista de quadros/pastas (acesso em tempo real) ──────────────
  // Quadros mudam raramente, então interval mais longo. Detecta quando o admin
  // atribui o usuario como responsavel em um novo quadro (aparece na sidebar)
  // e quando perde o acesso ao quadro ativo (pula para o primeiro disponivel).
  useEffect(() => {
    if (!dataLoaded) return;
    const POLL_MS = 15000;
    let cancelled = false;
    const sameIds = (a, b) => a.length === b.length && a.every((x, i) => x.id === b[i].id);
    const tick = async () => {
      if (cancelled) return;
      if (document.hidden) return;
      if (hasInFlightMutations()) return;
      const [boardsData, foldersData] = await Promise.all([
        apiCall("/boards"), apiCall("/folders"),
      ]);
      if (cancelled) return;
      if (Array.isArray(foldersData)) {
        setFolders(prev => sameIds(prev, foldersData) ? prev : foldersData);
      }
      if (Array.isArray(boardsData)) {
        setBoards(prev => sameIds(prev, boardsData) ? prev : boardsData);
        const stillHere = currentBoardId && boardsData.find(b => b.id === currentBoardId);
        if (!stillHere) {
          if (boardsData.length > 0) {
            // Acesso ao quadro atual foi removido OU acabou de ganhar acesso.
            switchBoard(boardsData[0].id);
          } else if (currentBoardId) {
            setCurrentBoardId(null);
            setTasks([]); setColumns([]); setSubColumns([]);
          }
        }
      }
    };
    const id = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line
  }, [dataLoaded, currentBoardId]);

  // ─── REORDENAÇÃO AUTOMÁTICA ───────────────────────────────────────────────
  // O quadro volta a se reorganizar na hora, como antes — mas a reordenação não
  // é aplicada DENTRO do clique. Ali a linha sairia debaixo do cursor e o clique
  // seguinte cairia em outra tarefa: era esse o bug de "mudei um status e o de
  // outras mudou junto". Ela é aplicada no fim do gesto, quando o próximo clique
  // não pode mais estar mirado numa linha prestes a se mover.
  const IDLE_REORDER_MS = 8000;
  // A linha tem 38px (cellStyle). Afastar ~40px do ponto do clique significa que
  // o cursor já deixou a faixa dela e está em trânsito, sem mirar em nada.
  const ROW_ESCAPE_PX = 40;
  // Toque não tem hover: lá o critério é um respiro depois de soltar o dedo,
  // maior que o intervalo de um duplo-toque.
  const TOUCH_SETTLE_MS = 500;

  const lastActivityRef = useRef(Date.now());
  // { x, y, ready } — ponto do clique que deixou a ordem suja. `ready` vira true
  // quando o gesto termina; até lá a reordenação fica represada.
  const pendingReorderRef = useRef(null);
  // Espelho do estado: os handlers leem a lista atual sem precisar de `tasks` nas
  // deps (o que recriaria os listeners a cada tecla digitada).
  const tasksRef = useRef(tasks);
  useEffect(() => { tasksRef.current = tasks; }, [tasks]);

  const canReorderNow = () => {
    if (!dataLoaded || !currentBoardId) return false;
    if (document.hidden) return false;
    if (hasInFlightMutations()) return false;
    const ae = document.activeElement;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return false;
    return true;
  };

  const flushReorder = () => {
    const idList = (arr) => (arr || []).map(x => x.id);
    const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
    const prev = tasksRef.current;
    pendingReorderRef.current = null;
    if (prev.length === 0) return;
    const next = sortTaskTree(prev);
    const prevSubs = new Map(prev.map(t => [t.id, idList(t.subitems)]));
    const tasksMoved = !sameList(idList(prev), idList(next));
    const subsMoved = next.filter(t => !sameList(prevSubs.get(t.id) || [], idList(t.subitems)));
    // Nada fora do lugar → não mexe. Sem isso a tela daria saltos gratuitos.
    if (!tasksMoved && subsMoved.length === 0) return;

    flipReorder(() => setTasks(next));
    if (tasksMoved) apiReorderTasks(idList(next));
    subsMoved.forEach(t => apiReorderSubitems(t.id, idList(t.subitems)));
  };
  // Guardado em ref para os listeners (registrados uma vez) sempre chamarem a
  // versão do render atual, sem closure velha.
  const flushReorderRef = useRef(null);
  flushReorderRef.current = flushReorder;
  const canReorderNowRef = useRef(null);
  canReorderNowRef.current = canReorderNow;
  // Chamado nos gatilhos: se o momento não for seguro a pendência continua de pé
  // e o tick periódico tenta de novo.
  const tryFlushReorder = () => { if (canReorderNowRef.current()) flushReorderRef.current(); };
  const tryFlushRef = useRef(null);
  tryFlushRef.current = tryFlushReorder;

  // Última posição conhecida do cursor: no instante do clique ela é a própria
  // posição do clique, que é o centro da faixa a proteger.
  const pointerRef = useRef({ x: 0, y: 0 });
  // Marca a ordem como suja. Chamado pelos setters quando status/prioridade mudam.
  const markReorderPending = () => { pendingReorderRef.current = { ...pointerRef.current, ready: false }; };

  useEffect(() => {
    const bump = () => { lastActivityRef.current = Date.now(); };
    const release = () => {
      const p = pendingReorderRef.current;
      if (!p || p.ready) return;
      p.ready = true;
      tryFlushRef.current();
    };
    const onPointerMove = (e) => {
      bump();
      pointerRef.current = { x: e.clientX, y: e.clientY };
      const p = pendingReorderRef.current;
      if (!p || p.ready) return;
      // Botão pressionado = arrasto em curso; reordenar no meio dele seria pior
      // que o bug original.
      if (e.buttons !== 0) return;
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < ROW_ESCAPE_PX) return;
      release();
    };
    const onPointerUp = (e) => {
      bump();
      // Toque: sem hover, o gatilho é o respiro após soltar o dedo.
      if (e.pointerType === "touch") setTimeout(release, TOUCH_SETTLE_MS);
    };
    // Rolar significa que o usuário abandonou aquela região da tela.
    const onWheel = () => { bump(); release(); };
    // Toque não gera pointermove antes do toque: registra a posição na descida.
    const onPointerDown = (e) => { bump(); pointerRef.current = { x: e.clientX, y: e.clientY }; };
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerup", onPointerUp, { passive: true });
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", bump);
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", bump);
      window.removeEventListener("wheel", onWheel);
    };
  }, []);

  // Rede de segurança: cobre teclado, pendência que ficou represada por um PUT
  // em voo, e o usuário que muda o status e simplesmente não mexe mais no mouse.
  useEffect(() => {
    if (!dataLoaded || !currentBoardId) return;
    const id = setInterval(() => {
      const p = pendingReorderRef.current;
      const idle = Date.now() - lastActivityRef.current >= IDLE_REORDER_MS;
      if (!p && !idle) return;
      if (p && !p.ready && !idle) return;
      tryFlushRef.current();
    }, 2000);
    return () => clearInterval(id);
  }, [dataLoaded, currentBoardId]);

  // ─── ALERTA DE ALTERAÇÕES NO QUADRO ────────────────────────────────────────
  // Qualquer mudança vinda do servidor (mensagem nova, tarefa/subitem criado ou
  // campo alterado) dispara: chime, popup do sistema, piscada no título e
  // destaque na linha afetada — o destaque só sai quando o usuário clica nela.
  const audioCtxRef = useRef(null);
  const [highlights, setHighlights] = useState({});
  const clearHighlight = (key) => setHighlights(h => { if (!h[key]) return h; const n = { ...h }; delete n[key]; return n; });
  const [notifSoundEnabled, setNotifSoundEnabled] = useState(() => localStorage.getItem("notifSoundEnabled") !== "0");
  // Ref espelhada para o audio effect ler sem entrar nas deps (toggle não reseta baseline).
  const notifSoundEnabledRef = useRef(notifSoundEnabled);
  useEffect(() => { notifSoundEnabledRef.current = notifSoundEnabled; localStorage.setItem("notifSoundEnabled", notifSoundEnabled ? "1" : "0"); }, [notifSoundEnabled]);
  // Popup nativo do sistema (Notification API): mesmo padrão do som — pref em
  // localStorage + ref espelhada. Só existe em contexto seguro (localhost/https).
  const notifPopupSupported = typeof window !== "undefined" && "Notification" in window;
  const [notifPopupEnabled, setNotifPopupEnabled] = useState(() => localStorage.getItem("notifPopupEnabled") !== "0");
  const [notifPermission, setNotifPermission] = useState(() => (typeof window !== "undefined" && "Notification" in window) ? Notification.permission : "unsupported");
  const notifPopupEnabledRef = useRef(notifPopupEnabled);
  useEffect(() => { notifPopupEnabledRef.current = notifPopupEnabled; localStorage.setItem("notifPopupEnabled", notifPopupEnabled ? "1" : "0"); }, [notifPopupEnabled]);
  // Popup só conta como ativo com a permissão concedida; o pedido de permissão
  // parte do clique do usuário, que é o que o Chrome exige para não bloquear.
  const notifPopupActive = notifPopupEnabled && notifPopupSupported && notifPermission === "granted";
  const toggleNotifPopup = async () => {
    if (!notifPopupSupported) return;
    if (notifPopupActive) { setNotifPopupEnabled(false); return; }
    if (Notification.permission === "default") {
      let perm = "denied";
      try { perm = await Notification.requestPermission(); } catch {}
      setNotifPermission(perm);
      if (perm !== "granted") return;
    } else if (Notification.permission !== "granted") {
      setNotifPermission(Notification.permission);
      alert("As notificações deste site estão bloqueadas no navegador.\n\nLibere em: cadeado/ícone ao lado do endereço → Notificações → Permitir.");
      return;
    }
    setNotifPopupEnabled(true);
  };
  // Som de notificação: toca client/public/notificacao.mp3. Se o arquivo faltar
  // ou o navegador recusar, cai no ringtone sintetizado logo abaixo — assim o
  // aviso nunca fica mudo.
  const audioElRef = useRef(null);
  const alarmUntilMsRef = useRef(0);
  const playChime = () => {
    if (Date.now() < alarmUntilMsRef.current) return;   // não empilha alertas
    alarmUntilMsRef.current = Date.now() + 900;
    try {
      if (!audioElRef.current) {
        audioElRef.current = new Audio((process.env.PUBLIC_URL || "") + "/notificacao.mp3");
        audioElRef.current.preload = "auto";
      }
      const el = audioElRef.current;
      el.currentTime = 0;
      const p = el.play();
      if (p && p.catch) p.catch(() => tocarSintetizado());
    } catch {
      tocarSintetizado();
    }
  };

  // Ringtone polifônico de reserva: três vozes tocando ao mesmo tempo — melodia,
  // harmonia em terças e baixo — sobre uma tríade de Dó maior. Sintetizado na
  // hora pela Web Audio API, sem depender de arquivo.
  const ALARM_SECONDS = 2.2;
  const alarmUntilRef = useRef(0);
  const tocarSintetizado = () => {
    try {
      if (!audioCtxRef.current) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) audioCtxRef.current = new Ctx();
      }
      const ctx = audioCtxRef.current;
      if (!ctx) return;
      if (ctx.state === "suspended") ctx.resume();
      const now = ctx.currentTime;
      // Já tem alerta tocando: não empilha um segundo por cima.
      if (now < alarmUntilRef.current) return;
      alarmUntilRef.current = now + ALARM_SECONDS;

      // Filtro suave tira o brilho agudo que deixa o sino estridente.
      const filtro = ctx.createBiquadFilter();
      filtro.type = "lowpass";
      filtro.frequency.setValueAtTime(2800, now);
      filtro.Q.setValueAtTime(0.7, now);
      filtro.connect(ctx.destination);

      // Saída geral: garante silêncio exato no fim, sem estalo, independente
      // do quanto a cauda do último toque ainda estivesse soando.
      const master = ctx.createGain();
      master.gain.setValueAtTime(1, now);
      master.gain.setValueAtTime(1, now + ALARM_SECONDS - 0.2);
      master.gain.linearRampToValueAtTime(0.0001, now + ALARM_SECONDS);
      master.connect(filtro);

      // Uma nota de sino: fundamental + oitava discreta, ataque rápido e
      // decaimento exponencial (é o decaimento que faz soar percussivo/doce
      // em vez de um bipe eletrônico).
      const nota = (freq, atraso, nivel, duracao = 1.6, brilho = 0.22) => {
        const t0 = now + atraso;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(nivel, t0 + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duracao);
        gain.connect(master);

        const fim = Math.min(t0 + duracao, now + ALARM_SECONDS) + 0.05;
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, t0);
        osc.connect(gain);
        osc.start(t0); osc.stop(fim);

        if (brilho > 0) {
          const harm = ctx.createOscillator();
          const harmGain = ctx.createGain();
          harm.type = "sine";
          harm.frequency.setValueAtTime(freq * 2, t0);
          harmGain.gain.setValueAtTime(brilho, t0);   // oitava só como brilho
          harm.connect(harmGain).connect(gain);
          harm.start(t0); harm.stop(fim);
        }
      };

      const SOL3 = 196.00, DO4 = 261.63, MI4 = 329.63, SOL4 = 392.00, SI4 = 493.88,
            DO5 = 523.25, MI5 = 659.25, SOL5 = 783.99, DO6 = 1046.50, MI6 = 1318.51;

      // 1) Baixo: sustenta a harmonia por baixo (I - V - I). Sem brilho, para
      //    ficar quente e não competir com a melodia.
      nota(DO4, 0.00, 0.085, 1.3, 0);
      nota(SOL3, 0.45, 0.085, 1.3, 0);
      nota(DO4, 0.90, 0.09, 1.6, 0);

      // 2) Acompanhamento: tríade inteira soando junto — é o que dá o corpo
      //    polifônico, com nível baixo para ficar atrás da melodia.
      nota(DO5, 0.00, 0.045, 1.4, 0.12);
      nota(MI5, 0.00, 0.042, 1.4, 0.12);
      nota(SOL5, 0.00, 0.040, 1.4, 0.12);
      nota(SI4, 0.45, 0.042, 1.2, 0.12);
      nota(SOL4, 0.45, 0.042, 1.2, 0.12);
      nota(MI4, 0.90, 0.042, 1.5, 0.12);
      nota(DO5, 0.90, 0.045, 1.5, 0.12);

      // 3) Melodia em cima, com a terça/sexta logo abaixo acompanhando —
      //    duas vozes andando juntas, marca do ringtone polifônico.
      const frase = [
        [SOL5, MI5, 0.00, 0.55],
        [DO6, SOL5, 0.22, 0.55],
        [MI6, DO6, 0.45, 0.55],
        [DO6, SOL5, 0.68, 0.75],
        [SOL5, MI5, 0.90, 1.15],
      ];
      frase.forEach(([alta, baixa, quando, cauda]) => {
        nota(alta, quando, 0.105, cauda);
        nota(baixa, quando, 0.062, cauda);
      });
    } catch {}
  };

  // Snapshot é reiniciado ao trocar de quadro: o primeiro load do quadro novo
  // apenas registra o estado atual, sem alertar.
  const boardSnapshotRef = useRef(null);
  useEffect(() => { boardSnapshotRef.current = null; setHighlights({}); }, [currentBoardId]);
  useEffect(() => {
    if (!dataLoaded) return;
    const userName = currentUser.name;
    const prev = boardSnapshotRef.current;
    const snap = { tasks: new Map(), subs: new Map(), updates: new Set() };
    const events = [];
    // Assinatura do item sem updates/subitens: qualquer campo alterado muda o hash.
    const sigOf = (obj, omit) => { const c = { ...obj }; omit.forEach(k => delete c[k]); return JSON.stringify(c); };
    const scanUpdates = (list, targetName, taskId, subId) => {
      for (const u of list || []) {
        if (!u || !u.id) continue;
        snap.updates.add(u.id);
        if (!prev || prev.updates.has(u.id)) continue;
        if (!u.author || u.author === userName) continue;
        events.push({ key: subId ? `s:${subId}` : `t:${taskId}`, taskId, subId, isMessage: true, kind: "message",
          title: `Nova mensagem de ${u.author}`, body: `${targetName}: ${(u.text || "").slice(0, 80)}` });
      }
    };
    for (const t of tasks) {
      const sig = sigOf(t, ["updates", "subitems"]);
      snap.tasks.set(t.id, sig);
      if (prev && !prev.tasks.has(t.id)) events.push({ key: `t:${t.id}`, taskId: t.id, kind: "new", title: "Nova tarefa", body: t.name });
      else if (prev && prev.tasks.get(t.id) !== sig) events.push({ key: `t:${t.id}`, taskId: t.id, kind: "changed", title: "Tarefa alterada", body: t.name });
      scanUpdates(t.updates, t.name, t.id, undefined);
      for (const s of t.subitems || []) {
        const ssig = sigOf(s, ["updates"]);
        snap.subs.set(s.id, ssig);
        if (prev && !prev.subs.has(s.id)) events.push({ key: `s:${s.id}`, taskId: t.id, subId: s.id, kind: "new", title: "Novo subitem", body: `${s.name} — em ${t.name}` });
        else if (prev && prev.subs.get(s.id) !== ssig) events.push({ key: `s:${s.id}`, taskId: t.id, subId: s.id, kind: "changed", title: "Subitem alterado", body: `${s.name} — em ${t.name}` });
        scanUpdates(s.updates, s.name, t.id, s.id);
      }
    }
    boardSnapshotRef.current = snap;

    const fromServer = pollAppliedRef.current;
    pollAppliedRef.current = false;
    if (!prev || events.length === 0) return;

    // Mudança feita pelo próprio usuário nesta aba: nada de som/popup, mas a
    // linha recém-criada acende assim mesmo, como confirmação visual. Edições
    // de campo do próprio usuário continuam passando em branco.
    if (!fromServer) {
      const created = events.filter(e => e.kind === "new");
      if (created.length) setHighlights(h => { const n = { ...h }; created.forEach(e => { n[e.key] = true; }); return n; });
      return;
    }

    setHighlights(h => { const n = { ...h }; events.forEach(e => { n[e.key] = true; }); return n; });
    if (notifSoundEnabledRef.current) playChime();

    if (document.hidden) {
      // O navegador ignora window.focus() sem gesto do usuário. Quem restaura
      // a janela de verdade é o assistente da bandeja (autostart/tray-helper.ps1),
      // escutando em loopback. Se não estiver instalado, o fetch falha e segue
      // o baralho — popup e título piscando continuam valendo.
      try { window.focus(); } catch {}
      fetch(TRAY_HELPER_URL, { mode: "no-cors", cache: "no-store" }).catch(() => {});
      if (notifPopupEnabledRef.current && notifPopupSupported && Notification.permission === "granted") {
        try {
          const main = events.find(e => e.isMessage) || events[events.length - 1];
          const many = events.length > 1;
          const n = new Notification(many ? `${events.length} alterações no quadro` : main.title,
            { body: many ? `${main.title}: ${main.body}` : main.body, tag: "rotina-board", renotify: true, requireInteraction: true });
          n.onclick = () => {
            try { window.focus(); } catch {}
            if (main.isMessage) setUpdatesTarget({ taskId: main.taskId, subId: main.subId });
            n.close();
          };
        } catch {}
      }
    }
  }, [tasks, dataLoaded, currentUser.name, notifPopupSupported]);

  // Enquanto houver destaque pendente, o título pisca (aparece na barra de
  // tarefas mesmo com a janela minimizada) e mostra a contagem quando visível.
  useEffect(() => {
    const count = Object.keys(highlights).length;
    const base = "Rotina Escritório";
    if (count === 0) { document.title = base; return; }
    let on = false;
    const tick = () => {
      if (!document.hidden) { document.title = `(${count}) ${base}`; return; }
      on = !on;
      // O nome base fica sempre no título: é por ele que o utilitário da
      // bandeja encontra a janela para trazer à frente.
      document.title = on ? `🔔 ${count} alteraç${count > 1 ? "ões" : "ão"} — ${base}` : base;
    };
    tick();
    const id = setInterval(tick, 1200);
    return () => { clearInterval(id); document.title = base; };
  }, [highlights]);

  // ─── API-BACKED SETTERS ────────────────────────────────────────────────────
  // Quem grava os horários automáticos é o servidor (relógio único para todos),
  // então o valor volta na resposta do PUT. Mesclamos SÓ as chaves das colunas
  // automáticas: copiar o custom inteiro atropelaria o que o usuário digitou em
  // outra célula enquanto a requisição estava no ar.
  const autoTimeColIds = useMemo(
    () => [...columns, ...subColumns].filter(c => c.autoTime).map(c => c.id),
    [columns, subColumns]
  );
  const mergeAutoTimes = (kind, tid, sid, res) => {
    if (!res?.custom || autoTimeColIds.length === 0) return;
    const patch = {};
    for (const id of autoTimeColIds) if (res.custom[id] !== undefined) patch[id] = res.custom[id];
    if (Object.keys(patch).length === 0) return;
    setTasks(prev => prev.map(t => {
      if (t.id !== tid) return t;
      if (kind === "task") return { ...t, custom: { ...(t.custom || {}), ...patch } };
      return { ...t, subitems: t.subitems.map(s => s.id === sid ? { ...s, custom: { ...(s.custom || {}), ...patch } } : s) };
    }));
  };

  const apiUpdateTask = (tid, newTask) => {
    const current = tasks.find(t => t.id === tid);
    const updated = typeof newTask === "function" ? newTask(current || {}) : newTask;
    // A linha NÃO se move aqui. Reordenar no instante do clique fazia a tarefa
    // fugir debaixo do cursor e o clique seguinte cair em outra tarefa — era a
    // causa de "mudei um status e o de outras mudou junto". Só marcamos a ordem
    // como suja; a reorganização sai no fim do gesto.
    if (!!current && updated && (current.priority !== updated.priority || current.status !== updated.status)) markReorderPending();
    setTasks(prev => prev.map(t => t.id === tid ? (typeof newTask === "function" ? newTask(t) : newTask) : t));
    apiCall(`/tasks/${tid}`, { method: "PUT", body: JSON.stringify(updated) })
      .then(res => mergeAutoTimes("task", tid, null, res));
  };

  const apiUpdateSub = (tid, sid, newSub) => {
    const parent = tasks.find(t => t.id === tid);
    const current = (parent?.subitems || []).find(s => s.id === sid);
    const subToSave = typeof newSub === "function" ? (current ? newSub(current) : {}) : newSub;
    // Mesma regra das tarefas: o subitem não muda de lugar no clique.
    if (!!current && subToSave && (current.priority !== subToSave.priority || current.status !== subToSave.status)) markReorderPending();
    setTasks(prev => prev.map(t => {
      if (t.id !== tid) return t;
      return { ...t, subitems: t.subitems.map(s => s.id === sid ? (typeof newSub === "function" ? newSub(s) : newSub) : s) };
    }));
    apiCall(`/subitems/${sid}`, { method: "PUT", body: JSON.stringify(subToSave) })
      .then(res => mergeAutoTimes("subitem", tid, sid, res));
  };

  const apiAddTask = (task) => {
    const taskWithBoard = { ...task, boardId: currentBoardId };
    setTasks(prev => [...prev, taskWithBoard]);
    apiCall("/tasks", { method: "POST", body: JSON.stringify(taskWithBoard) });
  };

  const apiDeleteTask = async (taskId) => {
    setTasks(prev => prev.filter(t => t.id !== taskId));
    const res = await apiCall(`/tasks/${taskId}`, { method: "DELETE", returnError: true });
    if (res?.error) {
      // Rollback on failure: refetch board tasks so the user doesn't see a phantom delete.
      const fresh = await apiCall(`/tasks?boardId=${encodeURIComponent(currentBoardId)}`);
      if (fresh) setTasks(prev => keepTaskTreeOrder(normalizeTasks(fresh), prev));
      return { error: res.error };
    }
    return { success: true };
  };

  const apiAddSubitem = (taskId, sub) => {
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, subitems: [...t.subitems, sub] } : t));
    apiCall("/subitems", { method: "POST", body: JSON.stringify({ ...sub, task_id: taskId }) });
  };

  const apiAddColumn = (col) => {
    const colWithBoard = { ...col, boardId: currentBoardId };
    setColumns(prev => [...prev, colWithBoard]);
    apiCall("/columns", { method: "POST", body: JSON.stringify(colWithBoard) });
  };

  const apiUpdateColumn = (colId, patch) => {
    setColumns(prev => prev.map(c => c.id === colId ? { ...c, ...patch } : c));
    apiCall(`/columns/${colId}`, { method: "PUT", body: JSON.stringify(patch) });
  };

  const apiDeleteColumn = (colId) => {
    setColumns(prev => prev.filter(c => c.id !== colId));
    apiCall(`/columns/${colId}`, { method: "DELETE" });
  };

  const apiReorderColumns = (orderedIds) => {
    apiCall("/columns/reorder", { method: "PUT", body: JSON.stringify({ order: orderedIds }) });
  };

  const apiReorderTasks = (orderedIds) => {
    apiCall("/tasks/reorder", { method: "PUT", body: JSON.stringify({ order: orderedIds }) });
  };

  const apiReorderSubitems = (taskId, orderedIds) => {
    apiCall("/subitems/reorder", { method: "PUT", body: JSON.stringify({ taskId, order: orderedIds }) });
  };

  const apiReorderSubColumns = (taskId, orderedSubColIds) => {
    setSubColumns(prev => {
      const byId = new Map(prev.map(sc => [sc.id, sc]));
      const others = prev.filter(sc => sc.taskId !== taskId);
      const reorderedTask = orderedSubColIds.map(id => byId.get(id)).filter(Boolean);
      const next = [...others, ...reorderedTask];
      apiCall("/columns/reorder", { method: "PUT", body: JSON.stringify({ order: [...columns.map(c => c.id), ...next.map(c => c.id)] }) });
      return next;
    });
  };

  const apiAddSubColumn = (col) => {
    const withScope = { ...col, scope: "subitem", taskId: col.taskId || activeSubColTaskId || null, boardId: currentBoardId };
    setSubColumns(prev => [...prev, withScope]);
    apiCall("/columns", { method: "POST", body: JSON.stringify(withScope) });
  };
  const apiUpdateSubColumn = (colId, patch) => {
    setSubColumns(prev => prev.map(c => c.id === colId ? { ...c, ...patch } : c));
    apiCall(`/columns/${colId}`, { method: "PUT", body: JSON.stringify(patch) });
  };
  const apiDeleteSubColumn = (colId) => {
    setSubColumns(prev => prev.filter(c => c.id !== colId));
    apiCall(`/columns/${colId}`, { method: "DELETE" });
  };

  const apiUpdateAutomation = (aid, active) => {
    setAutomations(prev => prev.map(a => a.id === aid ? { ...a, active } : a));
    apiCall(`/automations/${aid}`, { method: "PUT", body: JSON.stringify({ active }) });
  };

  // ─── BOARDS & FOLDERS ─────────────────────────────────────────────────────
  const apiCreateBoard = async (payload) => {
    const res = await apiCall("/boards", { method: "POST", body: JSON.stringify(payload) });
    if (!res || res.error) return { error: res?.error || "Erro ao criar quadro" };
    setBoards(prev => [...prev, res]);
    // Auto-switch to the freshly created board.
    await switchBoard(res.id);
    return { board: res };
  };
  const apiUpdateBoard = async (id, patch) => {
    const res = await apiCall(`/boards/${id}`, { method: "PUT", body: JSON.stringify(patch) });
    if (!res || res.error) return { error: res?.error || "Erro" };
    setBoards(prev => prev.map(b => b.id === id ? res : b));
    return { board: res };
  };
  const apiDeleteBoard = async (id) => {
    const res = await apiCall(`/boards/${id}`, { method: "DELETE" });
    if (!res || res.error) return { error: res?.error || "Erro" };
    setBoards(prev => {
      const next = prev.filter(b => b.id !== id);
      // If we deleted the active board, jump to the first remaining one.
      if (currentBoardId === id && next.length > 0) {
        setTimeout(() => switchBoard(next[0].id), 0);
      }
      return next;
    });
    return { success: true };
  };
  const apiCreateFolder = async (payload) => {
    const res = await apiCall("/folders", { method: "POST", body: JSON.stringify(payload) });
    if (!res || res.error) return { error: res?.error || "Erro ao criar pasta" };
    setFolders(prev => [...prev, res]);
    return { folder: res };
  };
  const apiUpdateFolder = async (id, patch) => {
    const res = await apiCall(`/folders/${id}`, { method: "PUT", body: JSON.stringify(patch) });
    if (!res || res.error) return { error: res?.error || "Erro" };
    setFolders(prev => prev.map(f => f.id === id ? res : f));
    return { folder: res };
  };
  const apiDeleteFolder = async (id) => {
    const res = await apiCall(`/folders/${id}`, { method: "DELETE" });
    if (!res || res.error) return { error: res?.error || "Erro" };
    setFolders(prev => prev.filter(f => f.id !== id));
    return { success: true };
  };
  const handleDeleteBoard = (board) => {
    if (!window.confirm(`Excluir o quadro "${board.name}"? Todas as tarefas e colunas dele serão removidas.`)) return;
    apiDeleteBoard(board.id).then(r => { if (r.error) alert(r.error); });
  };
  const handleDeleteFolder = (folder) => {
    if (!window.confirm(`Excluir a pasta "${folder.name}"?`)) return;
    apiDeleteFolder(folder.id).then(r => { if (r.error) alert(r.error); });
  };

  const apiUpdateUserRole = (userName, newRole) => {
    const u = users.find(x => x.name === userName);
    if (u) { setUsers(prev => prev.map(x => x.name === userName ? { ...x, role: newRole } : x)); apiCall(`/users/${u.id}/role`, { method: "PUT", body: JSON.stringify({ role: newRole }) }); }
  };

  const apiCreateUser = async ({ name, username, password, role }) => {
    const res = await apiCall('/users', { method: 'POST', body: JSON.stringify({ name, username, password, role }), returnError: true });
    if (!res || res.error) return { error: res?.error || 'Erro desconhecido' };
    setUsers(prev => [...prev, res].sort((a, b) => a.name.localeCompare(b.name)));
    if (res.avatar_color) PEOPLE_COLORS[res.name] = res.avatar_color;
    return { user: res };
  };

  const apiDeleteUser = async (userId) => {
    const res = await apiCall(`/users/${userId}`, { method: 'DELETE' });
    if (res?.error) return { error: res.error };
    // Re-fetch authoritative state from server (avoids any local-state drift).
    // Backend also strips the deleted name from responsible arrays in tasks/subitems,
    // so refetch tasks too so the UI reflects everything immediately.
    const [usersData, tasksData] = await Promise.all([
      apiCall('/users'),
      apiCall(`/tasks?boardId=${encodeURIComponent(currentBoardId)}`),
    ]);
    if (usersData) setUsers(usersData.map(u => ({ ...u, password: "******" })));
    else setUsers(prev => prev.filter(u => u.id !== userId));
    if (tasksData) setTasks(prev => keepTaskTreeOrder(normalizeTasks(tasksData), prev));
    return { success: true };
  };

  const apiUpdateUserProfile = (profileData) => {
    setUsers(prev => prev.map(u => u.name === currentUser.name ? { ...u, ...profileData } : u));
    if (profileData.avatarColor) PEOPLE_COLORS[profileData.name] = profileData.avatarColor;
    apiCall(`/users/${currentUser.id}`, { method: "PUT", body: JSON.stringify({ name: profileData.name, username: profileData.username, phone: profileData.phone, department: profileData.department, bio: profileData.bio, avatar_color: profileData.avatarColor, password: profileData.password !== "******" && profileData.password ? profileData.password : undefined }) });
  };

  const apiDeleteUpdate = (updateId) => {
    if (!updatesTarget) return;
    setTasks(prev => prev.map(t => {
      if (t.id !== updatesTarget.taskId) return t;
      if (updatesTarget.subId) {
        return { ...t, subitems: t.subitems.map(s => s.id === updatesTarget.subId ? { ...s, updates: (s.updates || []).filter(u => u.id !== updateId) } : s) };
      }
      return { ...t, updates: (t.updates || []).filter(u => u.id !== updateId) };
    }));
    apiCall(`/updates/${updateId}`, { method: "DELETE" });
  };

  const apiAddUpdate = (update) => {
    if (!updatesTarget) return;
    setTasks(prev => prev.map(t => {
      if (t.id !== updatesTarget.taskId) return t;
      if (updatesTarget.subId) return { ...t, subitems: t.subitems.map(s => s.id === updatesTarget.subId ? { ...s, updates: [...(s.updates || []), update] } : s) };
      return { ...t, updates: [...(t.updates || []), update] };
    }));
    apiCall("/updates", { method: "POST", body: JSON.stringify({ id: update.id, targetType: updatesTarget.subId ? "subitem" : "task", targetId: updatesTarget.subId || updatesTarget.taskId, text: update.text, mentions: update.mentions, files: update.files }) });
  };

  const currentUserData = useMemo(() => {
    const u = users.find(u => u.name === currentUser.name);
    return u || { ...currentUser, role: currentUser.role || "collaborator" };
  }, [users, currentUser]);
  const perms = useMemo(() => (ROLE_CONFIG[currentUserData.role] || ROLE_CONFIG.collaborator).permissions, [currentUserData]);
  const isAdmin = currentUserData.role === "admin";

  // Pessoas elegíveis como responsáveis = apenas usuários atualmente cadastrados.
  // Excluídos somem do picker; nomes legados em tarefas antigas continuam exibidos
  // na linha onde já estavam, mas não podem ser re-selecionados.
  const allPeople = useMemo(() => users.map(u => u.name).sort((a, b) => a.localeCompare(b)), [users]);
  const stats = useMemo(() => ({ total: tasks.length, done: tasks.filter(t => t.status === "Feito").length, inProgress: tasks.filter(t => t.status === "Em andamento").length, overdue: tasks.filter(t => t.deadline && daysUntil(t.deadline) < 0).length }), [tasks]);

  // Count notifications
  const notifCount = useMemo(() => {
    let count = 0;
    const userName = currentUser.name;
    tasks.forEach(t => {
      if ((t.responsible || []).includes(userName)) t.updates.forEach(u => { if (u.author !== userName) count++; });
      t.updates.forEach(u => { if (u.mentions.includes(userName) && u.author !== userName) count++; });
      t.subitems.forEach(sub => {
        if ((sub.responsible || []).includes(userName)) (sub.updates || []).forEach(u => { if (u.author !== userName) count++; });
        (sub.updates || []).forEach(u => { if (u.mentions.includes(userName) && u.author !== userName) count++; });
      });
    });
    return count;
  }, [tasks, currentUser]);

  const openUpdates = (taskId, subId) => setUpdatesTarget({ taskId, subId });

  const updatesData = useMemo(() => {
    if (!updatesTarget) return null;
    const task = tasks.find(t => t.id === updatesTarget.taskId);
    if (!task) return null;
    if (updatesTarget.subId) {
      const sub = task.subitems.find(s => s.id === updatesTarget.subId);
      return sub ? { name: sub.name, updates: sub.updates || [], isSub: true } : null;
    }
    return { name: task.name, updates: task.updates || [], isSub: false };
  }, [updatesTarget, tasks]);

  const addUpdate = (update) => {
    if (!updatesTarget) return;
    setTasks(prev => prev.map(t => {
      if (t.id !== updatesTarget.taskId) return t;
      if (updatesTarget.subId) {
        return { ...t, subitems: t.subitems.map(s => s.id === updatesTarget.subId ? { ...s, updates: [...(s.updates || []), update] } : s) };
      }
      return { ...t, updates: [...(t.updates || []), update] };
    }));
  };

  return (
    <div style={{ fontFamily: "'DM Sans', 'Segoe UI', system-ui, sans-serif", background: "#13151a", color: "#e8eaed", minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />

      {/* TOP BAR */}
      <div style={{ background: "#1a1d23", borderBottom: "1px solid #2a2d35", padding: "0 18px", height: 52, display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 30, height: 30, borderRadius: 7, background: "linear-gradient(135deg, #6c5ce7, #e2445c)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 14, color: "#fff" }}>R</div>
          <div><div style={{ fontWeight: 700, fontSize: 14, lineHeight: 1.2 }}>Rotina Escritório</div><div style={{ fontSize: 10, color: "#778ca3" }}>Gerenciamento de tarefas</div></div>
        </div>
        <SyncIndicator />
        <div style={{ flex: 1 }} />

        {/* User indicator with menu */}
        <div ref={userMenuRef} style={{ position: "relative" }}>
          <div onClick={() => setShowUserMenu(!showUserMenu)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", background: showUserMenu ? "rgba(108,92,231,.15)" : "#23262e", borderRadius: 20, border: "1px solid #333", cursor: "pointer", transition: "background .15s" }}
            onMouseEnter={e => e.currentTarget.style.background = "rgba(108,92,231,.1)"} onMouseLeave={e => { if (!showUserMenu) e.currentTarget.style.background = "#23262e"; }}>
            <Avatar name={currentUser.name} size={22} />
            <span style={{ fontSize: 12, fontWeight: 600, color: "#e8eaed", marginLeft: 4 }}>{currentUser.name}</span>
            <RoleBadge role={currentUserData.role} small />
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#778ca3" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>
          </div>
          {showUserMenu && (
            <div style={{ position: "absolute", top: "100%", right: 0, marginTop: 6, background: "#2a2d35", borderRadius: 12, padding: 8, minWidth: 240, zIndex: 60, boxShadow: "0 8px 30px rgba(0,0,0,.5)", border: "1px solid #3a3d45" }}>
              <div style={{ padding: "10px 12px", borderBottom: "1px solid #3a3d45", marginBottom: 4 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Avatar name={currentUser.name} size={32} />
                  <div style={{ marginLeft: 4, flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontWeight: 700, fontSize: 14, color: "#e8eaed" }}>{currentUser.name}</span>
                      <RoleBadge role={currentUserData.role} small />
                    </div>
                    <div style={{ fontSize: 11, color: "#778ca3" }}>@{currentUserData.username}</div>
                  </div>
                </div>
              </div>
              <div onClick={() => { setShowUserMenu(false); setShowProfile(true); }}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 8, cursor: "pointer", transition: "background .1s" }}
                onMouseEnter={e => e.currentTarget.style.background = "rgba(108,92,231,.08)"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6c5ce7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#6c5ce7" }}>Editar perfil</span>
              </div>
              {isAdmin && (
                <div onClick={() => { setShowUserMenu(false); setShowCreateUser(true); }}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 8, cursor: "pointer", transition: "background .1s" }}
                  onMouseEnter={e => e.currentTarget.style.background = "rgba(0,200,117,.08)"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#00c875" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#00c875" }}>Cadastrar usuário</span>
                </div>
              )}
              {isAdmin && (
                <div onClick={() => { setShowUserMenu(false); setShowAdminPanel(true); }}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 8, cursor: "pointer", transition: "background .1s" }}
                  onMouseEnter={e => e.currentTarget.style.background = "rgba(226,68,92,.08)"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <span style={{ fontSize: 15 }}>👑</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#e2445c" }}>Painel Admin</span>
                </div>
              )}
              {!isAdmin && (
                <div style={{ padding: "6px 12px", fontSize: 11, color: "#556", display: "flex", alignItems: "center", gap: 6 }}>
                  <LockedOverlay /> Painel Admin (restrito)
                </div>
              )}
              <div onClick={() => { setShowUserMenu(false); onLogout(); }}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 8, cursor: "pointer", transition: "background .1s", borderTop: "1px solid #3a3d45", marginTop: 4, paddingTop: 10 }}
                onMouseEnter={e => e.currentTarget.style.background = "rgba(226,68,92,.1)"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#e2445c" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#e2445c" }}>Sair</span>
              </div>
            </div>
          )}
        </div>

        {/* Stats */}
        <div style={{ display: "flex", gap: 12 }}>
          {[{ l: "Total", v: stats.total, c: "#579bfc" }, { l: "Andamento", v: stats.inProgress, c: "#fdab3d" }, { l: "Concluídas", v: stats.done, c: "#00c875" }, { l: "Atrasadas", v: stats.overdue, c: "#e2445c" }].map((s, i) => (
            <div key={i} style={{ textAlign: "center" }}><div style={{ fontSize: 15, fontWeight: 800, color: s.c }}>{s.v}</div><div style={{ fontSize: 9, color: "#778ca3", fontWeight: 600 }}>{s.l}</div></div>
          ))}
        </div>

        {/* Notification Bell */}
        <div ref={notifRef} style={{ position: "relative" }}>
          <div onClick={() => setShowNotifs(!showNotifs)} style={{ position: "relative", cursor: "pointer", width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 8, background: showNotifs ? "rgba(87,155,252,.15)" : "transparent", transition: "background .15s" }}
            onMouseEnter={e => e.currentTarget.style.background = "rgba(87,155,252,.1)"} onMouseLeave={e => { if (!showNotifs) e.currentTarget.style.background = "transparent"; }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={showNotifs ? "#579bfc" : "#778ca3"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>
            </svg>
            {notifCount > 0 && <div style={{ position: "absolute", top: 2, right: 2, minWidth: 16, height: 16, borderRadius: 8, background: "#e2445c", color: "#fff", fontSize: 9, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 3px" }}>{notifCount > 9 ? "9+" : notifCount}</div>}
          </div>
          {showNotifs && <NotificationPanel tasks={tasks} currentUser={currentUser.name} onClose={() => setShowNotifs(false)} onOpenUpdates={(tid, sid) => openUpdates(tid, sid)} soundEnabled={notifSoundEnabled} onToggleSound={() => setNotifSoundEnabled(v => !v)} popupEnabled={notifPopupActive} onTogglePopup={toggleNotifPopup} popupSupported={notifPopupSupported} popupBlocked={notifPermission === "denied"} />}
        </div>

        {isAdmin && (
          <div onClick={() => setShowReports(true)} title="Relatório diário" style={{ cursor: "pointer", width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 8, background: showReports ? "rgba(0,200,117,.15)" : "transparent", transition: "background .15s" }}
            onMouseEnter={e => e.currentTarget.style.background = "rgba(0,200,117,.1)"} onMouseLeave={e => { if (!showReports) e.currentTarget.style.background = "transparent"; }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={showReports ? "#00c875" : "#778ca3"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 3v18h18"/><path d="M7 14l3-3 4 4 5-6"/>
            </svg>
          </div>
        )}

        <button onClick={() => setShowDrive(true)} style={{ background: "rgba(66,133,244,.1)", color: "#4285f4", border: "1px solid rgba(66,133,244,.25)", borderRadius: 7, padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 5 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="#4285f4"><path d="M7.71 3.5L1.15 15l2.76 4.5h6.06L7.71 3.5zM8.8 3.5h6.06l6.56 12h-6.06L8.8 3.5zM16.62 16h-6.06l-2.76 4.5h6.06L16.62 16z" opacity=".9"/></svg>
          Drive
        </button>

        <button onClick={() => setShowAI(!showAI)} style={{ background: showAI ? "#6c5ce7" : "rgba(108,92,231,.15)", color: showAI ? "#fff" : "#a55eea", border: showAI ? "none" : "1px solid #6c5ce740", borderRadius: 7, padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>🤖 IA</button>
      </div>

      {/* TOOLBAR */}
      <div style={{ background: "#1a1d23", padding: "8px 18px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", borderBottom: "1px solid #2a2d35" }}>
        <div style={{ display: "flex", background: "#13151a", borderRadius: 7, overflow: "hidden", border: "1px solid #2a2d35" }}>
          {[{ key: "board", label: "Quadro", icon: "☰" }, { key: "kanban", label: "Kanban", icon: "▦" }, { key: "timeline", label: "Cronograma", icon: "◫" }].map(v => (
            <button key={v.key} onClick={() => setView(v.key)} style={{ padding: "7px 12px", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 4, background: view === v.key ? "#6c5ce7" : "transparent", color: view === v.key ? "#fff" : "#778ca3" }}><span>{v.icon}</span> {v.label}</button>
          ))}
        </div>

        {/* Board picker dropdown */}
        <div ref={boardPickerRef} style={{ position: "relative" }}>
          {(() => {
            const cb = boards.find(b => b.id === currentBoardId);
            return (
              <button onClick={() => setShowBoardPicker(s => !s)} title="Trocar de quadro" style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", border: "1px solid #2a2d35", borderRadius: 7, background: showBoardPicker ? "rgba(108,92,231,.15)" : "#13151a", color: "#e8eaed", fontSize: 12, fontWeight: 600, cursor: "pointer", maxWidth: 220 }}>
                <span style={{ fontSize: 14 }}>{cb?.icon || "📋"}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cb?.name || "Quadro"}</span>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#778ca3" strokeWidth="2.5" strokeLinecap="round"><path d="m6 9 6 6 6-6"/></svg>
              </button>
            );
          })()}
          {showBoardPicker && (
            <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, minWidth: 260, maxHeight: 360, overflowY: "auto", background: "#1a1d23", border: "1px solid #2a2d35", borderRadius: 8, boxShadow: "0 8px 30px rgba(0,0,0,.5)", padding: "6px 0", zIndex: 50 }}>
              {folders.map(f => {
                const fb = boards.filter(b => b.folderId === f.id);
                if (fb.length === 0) return null;
                return (
                  <div key={f.id}>
                    <div style={{ padding: "6px 12px 4px", fontSize: 10, color: "#778ca3", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, display: "flex", alignItems: "center", gap: 6 }}>
                      <span>{f.icon}</span><span>{f.name}</span>
                    </div>
                    {fb.map(b => {
                      const active = b.id === currentBoardId;
                      return (
                        <div key={b.id} onClick={() => { switchBoard(b.id); setShowBoardPicker(false); }}
                          style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 14px", cursor: "pointer", color: active ? "#fff" : "#c8cdd4", background: active ? "rgba(108,92,231,.15)" : "transparent", fontSize: 12, fontWeight: active ? 600 : 500 }}
                          onMouseEnter={e => { if (!active) e.currentTarget.style.background = "rgba(255,255,255,.04)"; }}
                          onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent"; }}>
                          <span style={{ fontSize: 13 }}>{b.icon}</span>
                          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name}</span>
                          {active && <span style={{ color: "#6c5ce7", fontWeight: 700 }}>✓</span>}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
              {isAdmin && (
                <>
                  <div style={{ borderTop: "1px solid #2a2d35", margin: "6px 0" }} />
                  <div onClick={() => { setShowBoardPicker(false); setNewBoardFolderId(null); setNewBoardMode("blank"); setShowNewBoard(true); }}
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", cursor: "pointer", color: "#6c5ce7", fontSize: 12, fontWeight: 600 }}
                    onMouseEnter={e => e.currentTarget.style.background = "rgba(108,92,231,.08)"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <span>＋</span><span>Novo quadro</span>
                  </div>
                  <div onClick={() => { setShowBoardPicker(false); setNewBoardFolderId(null); setNewBoardMode("copy"); setShowNewBoard(true); }}
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", cursor: "pointer", color: "#6c5ce7", fontSize: 12, fontWeight: 600 }}
                    onMouseEnter={e => e.currentTarget.style.background = "rgba(108,92,231,.08)"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <span>📋</span><span>Copiar quadro existente</span>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <div style={{ flex: 1 }} />
        {perms.addColumns ? (
          <button onClick={() => setShowAddCol(true)} style={{ background: "transparent", color: "#579bfc", border: "1px solid #579bfc40", borderRadius: 7, padding: "5px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>+ Coluna</button>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 10px", fontSize: 11, color: "#444", border: "1px solid #2a2d35", borderRadius: 7 }} title="Apenas administradores podem adicionar colunas"><LockedOverlay /> + Coluna</div>
        )}
        <div style={{ position: "relative" }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Pesquisar..." style={{ padding: "6px 8px 6px 26px", borderRadius: 7, border: "1px solid #333", background: "#13151a", color: "#e8eaed", fontSize: 12, width: 160, outline: "none" }} />
          <span style={{ position: "absolute", left: 7, top: "50%", transform: "translateY(-50%)", color: "#555", fontSize: 12 }}>🔍</span>
        </div>
        {perms.editTasks ? (
          <button onClick={() => setShowAddTask(true)} style={{ background: "#6c5ce7", color: "#fff", border: "none", borderRadius: 7, padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>+ Tarefa</button>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "6px 12px", fontSize: 12, color: "#444", background: "#23262e", borderRadius: 7 }} title="Sem permissão"><LockedOverlay /> + Tarefa</div>
        )}
      </div>

      {/* CONTENT */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <BoardsSidebar
          folders={folders}
          boards={boards}
          currentBoardId={currentBoardId}
          onSelectBoard={switchBoard}
          onNewBoard={(folderId) => { setNewBoardFolderId(folderId); setShowNewBoard(true); }}
          onNewFolder={() => setShowNewFolder(true)}
          onRenameBoard={(b) => setRenameBoardTarget(b)}
          onRenameFolder={(f) => setRenameFolderTarget(f)}
          onDeleteBoard={handleDeleteBoard}
          onDeleteFolder={handleDeleteFolder}
          onManageAccess={(b) => setAccessBoardTarget(b)}
          isAdmin={isAdmin}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => { const next = !sidebarCollapsed; setSidebarCollapsed(next); localStorage.setItem("rotina_sidebar_collapsed", next ? "1" : "0"); }}
          collapsedFolders={collapsedFolders}
          onToggleFolder={(fid) => setCollapsedFolders(prev => ({ ...prev, [fid]: !prev[fid] }))}
        />
        <div style={{ flex: 1, overflow: "auto", padding: 14 }}>
          {!currentBoardId && dataLoaded ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", flexDirection: "column", gap: 16, color: "#778ca3", textAlign: "center", padding: 24 }}>
              <div style={{ fontSize: 48, opacity: 0.4 }}>🔒</div>
              <div style={{ fontWeight: 700, fontSize: 18, color: "#c8cdd4" }}>Você não tem acesso a nenhum quadro</div>
              <div style={{ fontSize: 13, maxWidth: 420, lineHeight: 1.5 }}>Para visualizar um quadro, peça a um administrador para te atribuir como responsável em alguma tarefa. Quando isso acontecer, o quadro aparece automaticamente aqui.</div>
            </div>
          ) : (<>
            {view === "board" && <BoardView tasks={tasks} setTasks={setTasks} apiUpdateTask={apiUpdateTask} apiUpdateSub={apiUpdateSub} apiAddTask={apiAddTask} apiDeleteTask={apiDeleteTask} apiAddSubitem={apiAddSubitem} search={search} allPeople={allPeople} columns={columns} setColumns={setColumns} apiUpdateColumn={apiUpdateColumn} apiDeleteColumn={apiDeleteColumn} apiReorderColumns={apiReorderColumns} apiReorderTasks={apiReorderTasks} apiReorderSubitems={apiReorderSubitems} setShowAddCol={setShowAddCol} subColumns={subColumns} setSubColumns={setSubColumns} apiUpdateSubColumn={apiUpdateSubColumn} apiDeleteSubColumn={apiDeleteSubColumn} apiReorderSubColumns={apiReorderSubColumns} setShowAddSubCol={setShowAddSubCol} setActiveSubColTaskId={setActiveSubColTaskId} onOpenUpdates={openUpdates} perms={perms} highlights={highlights} onClearHighlight={clearHighlight} />}
            {view === "kanban" && <KanbanView tasks={tasks} setTasks={setTasks} apiUpdateTask={apiUpdateTask} search={search} allPeople={allPeople} onOpenUpdates={openUpdates} highlights={highlights} onClearHighlight={clearHighlight} />}
            {view === "timeline" && <TimelineView tasks={tasks} search={search} />}
          </>)}
        </div>
        {showAI && (
          <div style={{ width: 320, background: "#1a1d23", borderLeft: "1px solid #2a2d35", overflow: "auto", padding: 12, flexShrink: 0, animation: "slideIn .2s ease" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}><span style={{ fontWeight: 700, fontSize: 14 }}>🤖 Assistente IA</span><button onClick={() => setShowAI(false)} style={{ background: "none", border: "none", color: "#778ca3", fontSize: 18, cursor: "pointer" }}>×</button></div>
            <AIPanel tasks={tasks} columns={columns} subColumns={subColumns} users={users} automations={automations} setAutomations={(arg) => {
              const next = typeof arg === "function" ? arg(automations) : arg;
              setAutomations(next);
              const changed = next.find((a, i) => automations[i] && a.active !== automations[i].active && a.id === automations[i].id);
              if (changed) apiUpdateAutomation(changed.id, changed.active);
            }} canManageAutomations={perms.manageAutomations} onDataChanged={async () => {
              const [tasksData, autoData] = await Promise.all([apiCall(`/tasks?boardId=${encodeURIComponent(currentBoardId)}`), apiCall("/automations")]);
              if (tasksData) setTasks(prev => keepTaskTreeOrder(normalizeTasks(tasksData), prev));
              if (autoData) setAutomations(autoData);
            }} />
          </div>
        )}
      </div>

      {showNewBoard && (
        <NewBoardModal
          folders={folders}
          boards={boards}
          defaultFolderId={newBoardFolderId}
          defaultMode={newBoardMode}
          onClose={() => { setShowNewBoard(false); setNewBoardFolderId(null); setNewBoardMode("blank"); }}
          onCreate={apiCreateBoard}
        />
      )}
      {showNewFolder && (
        <NewFolderModal
          onClose={() => setShowNewFolder(false)}
          onCreate={apiCreateFolder}
        />
      )}
      {renameFolderTarget && (
        <NewFolderModal
          target={renameFolderTarget}
          onClose={() => setRenameFolderTarget(null)}
          onCreate={(payload) => apiUpdateFolder(renameFolderTarget.id, payload)}
        />
      )}
      {accessBoardTarget && (
        <BoardAccessModal
          board={accessBoardTarget}
          onClose={(changed) => {
            setAccessBoardTarget(null);
            // Recarrega a lista de quadros: quem perdeu/ganhou acesso vê na hora.
            if (changed) apiCall("/boards").then(bs => { if (Array.isArray(bs)) setBoards(bs); });
          }}
        />
      )}
      {renameBoardTarget && (
        <RenameBoardModal
          target={renameBoardTarget}
          onClose={() => setRenameBoardTarget(null)}
          onSave={(payload) => apiUpdateBoard(renameBoardTarget.id, payload)}
        />
      )}
      {showAddTask && <AddTaskModal onClose={() => setShowAddTask(false)} onAdd={apiAddTask} allPeople={allPeople} />}
      {showAddCol && perms.addColumns && <AddColumnModal onClose={() => setShowAddCol(false)} onAdd={apiAddColumn} columns={columns} />}
      {showAddSubCol && perms.addColumns && <AddColumnModal onClose={() => setShowAddSubCol(false)} onAdd={apiAddSubColumn} columns={columns} title="Adicionar Coluna de Subitem" linkParent />}
      {updatesData && <UpdatesPanel itemName={updatesData.name} updates={updatesData.updates} currentUserName={currentUser.name} onAddUpdate={apiAddUpdate} onDeleteUpdate={apiDeleteUpdate} onEditUpdate={(updateId, newText, newFiles) => {
        if (!updatesTarget) return;
        setTasks(prev => prev.map(t => {
          if (t.id !== updatesTarget.taskId) return t;
          if (updatesTarget.subId) {
            return { ...t, subitems: t.subitems.map(s => s.id === updatesTarget.subId ? { ...s, updates: (s.updates || []).map(u => u.id === updateId ? { ...u, text: newText, files: newFiles !== undefined ? newFiles : u.files } : u) } : s) };
          }
          return { ...t, updates: (t.updates || []).map(u => u.id === updateId ? { ...u, text: newText, files: newFiles !== undefined ? newFiles : u.files } : u) };
        }));
      }} onDeleteFile={(updateId, fileIndex) => {
        if (!updatesTarget) return;
        setTasks(prev => prev.map(t => {
          if (t.id !== updatesTarget.taskId) return t;
          const removeFile = (updates) => (updates || []).map(u => u.id === updateId ? { ...u, files: (u.files || []).filter((_, i) => i !== fileIndex) } : u);
          if (updatesTarget.subId) {
            return { ...t, subitems: t.subitems.map(s => s.id === updatesTarget.subId ? { ...s, updates: removeFile(s.updates) } : s) };
          }
          return { ...t, updates: removeFile(t.updates) };
        }));
      }} onClose={() => setUpdatesTarget(null)} allPeople={allPeople} />}
      {showDrive && <GoogleDrivePanel onClose={() => setShowDrive(false)} />}
      {showAdminPanel && isAdmin && <AdminPanel users={users} onUpdateRole={apiUpdateUserRole} onCreateUser={apiCreateUser} onDeleteUser={apiDeleteUser} onClose={() => setShowAdminPanel(false)} currentUser={currentUser.name} currentUserId={currentUser.id} />}
      {showReports && isAdmin && <ReportsPanel fullscreen={reportsFullscreen} onToggleFullscreen={() => setReportsFullscreen(f => !f)} onClose={() => { setShowReports(false); setReportsFullscreen(false); }} boardId={currentBoardId} boardName={(boards.find(b => b.id === currentBoardId) || {}).name} />}
      {showProfile && <ProfileEditor userData={currentUserData} onSave={apiUpdateUserProfile} onClose={() => setShowProfile(false)} allUsers={users} />}
      {showCreateUser && isAdmin && <CreateUserModal onClose={() => setShowCreateUser(false)} onCreate={apiCreateUser} />}

      <style>{`
        @keyframes slideIn { from { transform: translateX(20px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        @keyframes syncSpin { to { transform: rotate(360deg); } }
        @keyframes hotRow {
          0%, 100% { box-shadow: inset 0 0 0 2px rgba(253,171,61,.45); }
          50% { box-shadow: inset 0 0 0 2px rgba(253,171,61,1), inset 0 0 26px rgba(253,171,61,.28); }
        }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: #13151a; }
        ::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: #555; }
        select { appearance: auto; }
        input[type="date"]::-webkit-calendar-picker-indicator { filter: invert(0.7); }
        textarea::-webkit-scrollbar { width: 4px; }
      `}</style>
    </div>
  );
}

// ─── ROOT APP (Login wrapper) ────────────────────────────────────────────────
export default function App() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);

  // Check for existing token on mount
  useEffect(() => {
    async function checkAuth() {
      if (getToken()) {
        const me = await apiCall("/auth/me");
        if (me) { setUser(me); }
        else { setToken(null); }
      }
      setChecking(false);
    }
    checkAuth();
  }, []);

  const handleLogout = () => { setToken(null); setUser(null); };

  if (checking) return (
    <div style={{ fontFamily: "'DM Sans', system-ui, sans-serif", background: "#0b0d11", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      <div style={{ textAlign: "center" }}>
        <div style={{ width: 48, height: 48, borderRadius: 12, background: "linear-gradient(135deg, #6c5ce7, #e2445c)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 22, color: "#fff", marginBottom: 16 }}>R</div>
        <div style={{ color: "#778ca3", fontSize: 14 }}>Carregando...</div>
      </div>
      <style>{`* { box-sizing: border-box; margin: 0; }`}</style>
    </div>
  );

  if (!user) return <LoginScreen onLogin={(userData) => setUser(userData)} />;
  return <Dashboard currentUser={user} onLogout={handleLogout} />;
}
