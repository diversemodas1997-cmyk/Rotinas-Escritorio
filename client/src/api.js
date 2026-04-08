const API_URL = process.env.REACT_APP_API_URL || (window.location.hostname === 'localhost' ? 'http://localhost:3001' : '') ;

let authToken = localStorage.getItem('rotina_token');

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (authToken) h['Authorization'] = `Bearer ${authToken}`;
  return h;
}

async function request(path, options = {}) {
  const res = await fetch(`${API_URL}/api${path}`, { ...options, headers: { ...headers(), ...options.headers } });
  if (res.status === 401) { authToken = null; localStorage.removeItem('rotina_token'); window.location.reload(); return null; }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Erro no servidor');
  return data;
}

export const api = {
  setToken(token) { authToken = token; localStorage.setItem('rotina_token', token); },
  clearToken() { authToken = null; localStorage.removeItem('rotina_token'); },
  getToken() { return authToken; },

  login: (email, password) => request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  me: () => request('/auth/me'),

  getUsers: () => request('/users'),
  updateUser: (id, data) => request(`/users/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  updateUserRole: (id, role) => request(`/users/${id}/role`, { method: 'PUT', body: JSON.stringify({ role }) }),

  getTasks: () => request('/tasks'),
  createTask: (task) => request('/tasks', { method: 'POST', body: JSON.stringify(task) }),
  updateTask: (id, data) => request(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteTask: (id) => request(`/tasks/${id}`, { method: 'DELETE' }),

  updateSubitem: (id, data) => request(`/subitems/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

  createUpdate: (data) => request('/updates', { method: 'POST', body: JSON.stringify(data) }),

  getColumns: () => request('/columns'),
  createColumn: (col) => request('/columns', { method: 'POST', body: JSON.stringify(col) }),
  updateColumn: (id, data) => request(`/columns/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteColumn: (id) => request(`/columns/${id}`, { method: 'DELETE' }),

  getAutomations: () => request('/automations'),
  updateAutomation: (id, active) => request(`/automations/${id}`, { method: 'PUT', body: JSON.stringify({ active }) }),
};
