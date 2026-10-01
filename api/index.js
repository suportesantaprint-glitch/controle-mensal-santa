const express = require('express');
const { MongoClient, ServerApiVersion } = require('mongodb');
const tls = require('tls');
const dotenv = require('dotenv');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// Carregar variáveis de ambiente localmente se existirem
if (fs.existsSync(path.join(process.cwd(), '.env'))) {
  dotenv.config({ path: path.join(process.cwd(), '.env') });
} else if (fs.existsSync(path.join(process.cwd(), 'atlas-credentials.env'))) {
  dotenv.config({ path: path.join(process.cwd(), 'atlas-credentials.env') });
} else {
  dotenv.config();
}

// O Atlas aceita TLS 1.2 e 1.3, mas alguns runtimes serverless/OpenSSL
// apresentam ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR ao negociar TLS 1.3.
// Fixamos o teto em TLS 1.2 para manter compatibilidade sem desabilitar validação SSL.
tls.DEFAULT_MIN_VERSION = 'TLSv1.2';
tls.DEFAULT_MAX_VERSION = 'TLSv1.2';

const app = express();

// Sanitizar URI e variáveis de ambiente (remove aspas acidentais)
const rawUri = process.env.MONGODB_URI || '';
const MONGODB_URI = rawUri.replace(/^["']|["']$/g, '').trim();
const rawDbName = process.env.DB_NAME || 'painel_tarefas_db';
const DB_NAME = rawDbName.replace(/^["']|["']$/g, '').trim();

const RETENTION_MONTHS = 4;

function parseRecordDate(value, fallback = new Date()) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(value.getTime());
  }

  if (typeof value === 'string') {
    const isoDate = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoDate) {
      const [, year, month, day] = isoDate;
      return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12, 0, 0));
    }

    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return new Date(fallback.getTime());
}

function calculateExpiresAt(baseDate) {
  const date = parseRecordDate(baseDate);
  const expiresAt = new Date(date.getTime());
  expiresAt.setUTCMonth(expiresAt.getUTCMonth() + RETENTION_MONTHS);
  return expiresAt;
}

async function ensureRetentionMetadata(db) {
  const tasks = db.collection('tasks');
  const notes = db.collection('notes');

  await Promise.all([
    tasks.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    notes.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    tasks.createIndex({ d: 1 }),
  ]);

  const taskOps = [];
  const taskCursor = tasks.find(
    { expiresAt: { $exists: false } },
    { projection: { _id: 1, d: 1, createdAt: 1, updatedAt: 1 } }
  );

  for await (const task of taskCursor) {
    const fallback =
      task.createdAt ||
      task.updatedAt ||
      (task._id && typeof task._id.getTimestamp === 'function' ? task._id.getTimestamp() : new Date());

    taskOps.push({
      updateOne: {
        filter: { _id: task._id, expiresAt: { $exists: false } },
        update: { $set: { expiresAt: calculateExpiresAt(task.d || fallback) } }
      }
    });

    if (taskOps.length >= 500) {
      await tasks.bulkWrite(taskOps, { ordered: false });
      taskOps.length = 0;
    }
  }

  if (taskOps.length) {
    await tasks.bulkWrite(taskOps, { ordered: false });
  }

  const noteOps = [];
  const noteCursor = notes.find(
    { expiresAt: { $exists: false } },
    { projection: { _id: 1, date: 1, updatedAt: 1 } }
  );

  for await (const note of noteCursor) {
    const fallback =
      note.updatedAt ||
      (note._id && typeof note._id.getTimestamp === 'function' ? note._id.getTimestamp() : new Date());

    noteOps.push({
      updateOne: {
        filter: { _id: note._id, expiresAt: { $exists: false } },
        update: { $set: { expiresAt: calculateExpiresAt(note.date || fallback) } }
      }
    });

    if (noteOps.length >= 500) {
      await notes.bulkWrite(noteOps, { ordered: false });
      noteOps.length = 0;
    }
  }

  if (noteOps.length) {
    await notes.bulkWrite(noteOps, { ordered: false });
  }
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(process.cwd(), 'public')));

// Cache de conexão para ambiente Serverless da Vercel
let cachedClient = null;
let cachedDb = null;
let connectionPromise = null;

function normalizeMongoError(err) {
  const message = err?.message || String(err || 'Erro desconhecido');

  if (/TLSV1_ALERT_INTERNAL_ERROR|SSL alert number 80/i.test(message)) {
    return {
      code: 'MONGODB_TLS_HANDSHAKE',
      message,
      hint: 'Falha no handshake TLS com o MongoDB Atlas. O backend já força TLS 1.2; confirme também se o cluster está ativo e acessível.'
    };
  }

  if (/authentication failed|bad auth|AuthenticationFailed/i.test(message)) {
    return {
      code: 'MONGODB_AUTH',
      message,
      hint: 'Usuário ou senha do MongoDB Atlas inválidos. Atualize MONGODB_URI na Vercel.'
    };
  }

  if (/ENOTFOUND|querySrv|DNS|SRV/i.test(message)) {
    return {
      code: 'MONGODB_DNS',
      message,
      hint: 'Falha de DNS/SRV ao resolver o cluster do MongoDB Atlas.'
    };
  }

  if (/Server selection timed out|ECONNREFUSED|ETIMEDOUT/i.test(message)) {
    return {
      code: 'MONGODB_NETWORK',
      message,
      hint: 'O cluster não respondeu. Confira Network Access no Atlas e se o cluster está ativo.'
    };
  }

  return {
    code: 'MONGODB_UNKNOWN',
    message,
    hint: 'Verifique MONGODB_URI, DB_NAME e o estado do cluster no MongoDB Atlas.'
  };
}

async function openDatabase() {
  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI não configurada nas variáveis de ambiente da Vercel.');
  }

  const client = new MongoClient(MONGODB_URI, {
    serverApi: {
      version: ServerApiVersion.v1,
      strict: false,
      deprecationErrors: true,
    },
    serverSelectionTimeoutMS: 8000,
    connectTimeoutMS: 10000,
    socketTimeoutMS: 20000,
    maxPoolSize: 10,
    minPoolSize: 0,
    maxIdleTimeMS: 30000,
    retryReads: true,
    retryWrites: true,
  });

  await client.connect();
  const db = client.db(DB_NAME);
  await db.command({ ping: 1 });

  await Promise.all([
    db.collection('tasks').createIndex({ id: 1 }, { unique: true }),
    db.collection('notes').createIndex({ date: 1 }, { unique: true }),
  ]);

  await ensureRetentionMetadata(db);

  cachedClient = client;
  cachedDb = db;
  return { client, db };
}

async function getDatabase() {
  if (cachedClient && cachedDb) {
    return { client: cachedClient, db: cachedDb };
  }

  if (!connectionPromise) {
    connectionPromise = openDatabase()
      .catch((err) => {
        cachedClient = null;
        cachedDb = null;
        throw err;
      })
      .finally(() => {
        connectionPromise = null;
      });
  }

  return connectionPromise;
}

// Rota de status do sistema e banco
app.get('/api/status', async (req, res) => {
  try {
    const { db } = await getDatabase();
    const tasksCount = await db.collection('tasks').countDocuments().catch(() => 0);
    const notesCount = await db.collection('notes').countDocuments().catch(() => 0);

    res.json({
      status: 'online',
      connected: true,
      database: DB_NAME,
      counts: { tasks: tasksCount, notes: notesCount },
      retention: {
        months: RETENTION_MONTHS,
        mode: 'mongodb-ttl'
      },
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    const problem = normalizeMongoError(err);
    res.status(503).json({
      status: 'offline',
      connected: false,
      code: problem.code,
      error: problem.message,
      hint: problem.hint,
      database: DB_NAME,
      runtime: process.version,
      tls: {
        min: tls.DEFAULT_MIN_VERSION,
        max: tls.DEFAULT_MAX_VERSION
      },
      timestamp: new Date().toISOString()
    });
  }
});

// Listar tarefas
app.get('/api/tasks', async (req, res) => {
  try {
    const { db } = await getDatabase();
    const tasks = await db.collection('tasks').find({}, { projection: { _id: 0 } }).toArray();
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar tarefas', details: err.message });
  }
});

// Criar nova tarefa
app.post('/api/tasks', async (req, res) => {
  try {
    const { db } = await getDatabase();
    const task = req.body;
    if (!task || !task.t) {
      return res.status(400).json({ error: 'Título da tarefa é obrigatório' });
    }

    const id = task.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    const newTask = {
      id,
      t: String(task.t).trim(),
      d: task.d || '',
      s: task.s || 'todo',
      c: Number.isInteger(task.c) ? task.c : 0,
      w: task.w ? String(task.w).trim() : '',
      n: task.n ? String(task.n).trim() : '',
      createdAt: new Date().toISOString(),
      expiresAt: calculateExpiresAt(task.d || new Date())
    };

    await db.collection('tasks').updateOne({ id }, { $set: newTask }, { upsert: true });
    res.status(201).json(newTask);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao salvar tarefa', details: err.message });
  }
});

// Atualizar tarefa
app.put('/api/tasks/:id', async (req, res) => {
  try {
    const { db } = await getDatabase();
    const { id } = req.params;
    const task = req.body;
    const current = await db.collection('tasks').findOne(
      { id },
      { projection: { _id: 0, d: 1, createdAt: 1, updatedAt: 1 } }
    );

    if (!current) {
      return res.status(404).json({ error: 'Tarefa não encontrada' });
    }

    const updateData = { ...task };
    delete updateData._id;
    delete updateData.id;
    updateData.updatedAt = new Date().toISOString();

    const effectiveDate = updateData.d !== undefined ? updateData.d : current.d;
    const retentionBase = effectiveDate || current.createdAt || current.updatedAt || new Date();
    updateData.expiresAt = calculateExpiresAt(retentionBase);

    const result = await db.collection('tasks').updateOne({ id }, { $set: updateData });
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Tarefa não encontrada' });
    }

    const updated = await db.collection('tasks').findOne({ id }, { projection: { _id: 0 } });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar tarefa', details: err.message });
  }
});

// Deletar tarefa
app.delete('/api/tasks/:id', async (req, res) => {
  try {
    const { db } = await getDatabase();
    const { id } = req.params;
    const result = await db.collection('tasks').deleteOne({ id });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Tarefa não encontrada' });
    }
    res.json({ success: true, message: 'Tarefa excluída com sucesso', id });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao excluir tarefa', details: err.message });
  }
});

// Sincronização em massa
app.post('/api/tasks/bulk', async (req, res) => {
  try {
    const { db } = await getDatabase();
    const { tasks, notes } = req.body;
    let taskCount = 0;
    let noteCount = 0;

    if (Array.isArray(tasks)) {
      for (const t of tasks) {
        if (!t.t) continue;
        const id = t.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
        const createdAt = t.createdAt || new Date().toISOString();
        await db.collection('tasks').updateOne(
          { id },
          {
            $set: {
              id,
              t: t.t,
              d: t.d || '',
              s: t.s || 'todo',
              c: Number.isInteger(t.c) ? t.c : 0,
              w: t.w || '',
              n: t.n || '',
              createdAt,
              expiresAt: calculateExpiresAt(t.d || createdAt)
            }
          },
          { upsert: true }
        );
        taskCount++;
      }
    }

    if (notes && typeof notes === 'object') {
      for (const [date, content] of Object.entries(notes)) {
        if (typeof content === 'string' && content.trim()) {
          await db.collection('notes').updateOne(
            { date },
            {
              $set: {
                date,
                content: content.trim(),
                expiresAt: calculateExpiresAt(date)
              }
            },
            { upsert: true }
          );
          noteCount++;
        }
      }
    }

    res.json({ success: true, importedTasks: taskCount, importedNotes: noteCount });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao sincronizar em lote', details: err.message });
  }
});

// Listar anotações
app.get('/api/notes', async (req, res) => {
  try {
    const { db } = await getDatabase();
    const list = await db.collection('notes').find({}, { projection: { _id: 0 } }).toArray();
    const notesMap = {};
    list.forEach(item => {
      notesMap[item.date] = item.content;
    });
    res.json(notesMap);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar anotações', details: err.message });
  }
});

// Salvar anotação por data
app.put('/api/notes/:date', async (req, res) => {
  try {
    const { db } = await getDatabase();
    const { date } = req.params;
    const { content } = req.body;

    if (!content || !content.trim()) {
      await db.collection('notes').deleteOne({ date });
      return res.json({ success: true, message: 'Anotação removida' });
    }

    await db.collection('notes').updateOne(
      { date },
      {
        $set: {
          date,
          content: content.trim(),
          updatedAt: new Date().toISOString(),
          expiresAt: calculateExpiresAt(date)
        }
      },
      { upsert: true }
    );
    res.json({ success: true, date, content: content.trim() });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao salvar anotação', details: err.message });
  }
});

module.exports = app;
