// Uso: node copia-banco.js <arquivo-destino.sqlite>
// Tira uma cópia do banco NA HORA, com a API de backup do SQLite (consistente
// mesmo com o servidor gravando em modo WAL), e confere a cópia antes de
// devolver ok. Sai com código 1 se algo não bater — nunca deixa uma cópia
// quebrada no destino.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const destino = process.argv[2];
if (!destino) { console.error('informe o arquivo de destino'); process.exit(1); }
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'database.sqlite');

(async () => {
  const tmp = destino + '.parcial';
  try {
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    await db.backup(tmp);
    db.close();
    const c = new Database(tmp);
    const ok = c.pragma('integrity_check', { simple: true });
    const usuarios = c.prepare('SELECT COUNT(*) n FROM users').get().n;
    const tarefas = c.prepare('SELECT COUNT(*) n FROM tasks').get().n;
    // A cópia herda o modo WAL; sair dele faz o arquivo valer sozinho, sem
    // -wal/-shm ao lado (que o Drive levaria pela metade).
    c.pragma('journal_mode = DELETE');
    c.close();
    if (ok !== 'ok' || !usuarios) throw new Error(`cópia inconsistente (integridade: ${ok}, usuários: ${usuarios})`);
    fs.renameSync(tmp, destino);
    console.log(`${usuarios} usuarios, ${tarefas} tarefas, integridade ok`);
  } catch (e) {
    for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.unlinkSync(f); } catch {} }
    console.error(e.message);
    process.exit(1);
  }
})();
