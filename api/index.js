const express = require('express');
const { MongoClient } = require('mongodb');
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

const app = express();
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'painel_tarefas_db';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(process.cwd(), 'public')));

// Cache de conexão para ambiente Serverless da Vercel
let cachedClient = null;
let cachedDb = null;

async function getDatabase() {
  if (cachedDb) {
    return { client: cachedClient, db: cachedDb };
  }

  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI não configurada nas variáveis de ambiente da Vercel.');
  }

  const client = new MongoClient(MONGODB_URI, {
    serverSelectionTimeoutMS: 8000,
    maxPoolSize: 10,
  });

  await client.connect();
  const db = client.db(DB_NAME);

  // Inicializar índices
  try {
    await db.collection('tasks').createIndex({ id: 1 }, { unique: true });
    await db.collection('notes').createIndex({ date: 1 }, { unique: true });
  } catch (e) {}

  cachedClient = client;
  cachedDb = db;
  return { client, db };
}

// Rota de status do sistema e banco
app.get('/api/status', async (req, res) => {
  try {
    const { db } = await getDatabase();
    const tasksCount = await db.collection('tasks').countDocuments();
    const notesCount = await db.collection('notes').countDocuments();

    res.json({
      status: 'online',
      connected: true,
      database: DB_NAME,
      counts: { tasks: tasksCount, notes: notesCount },
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({
      status: 'offline',
      connected: false,
      error: err.message,
      database: DB_NAME
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
      createdAt: new Date().toISOString()
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
    const updateData = { ...task };
    delete updateData._id;
    delete updateData.id;
    updateData.updatedAt = new Date().toISOString();

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
        await db.collection('tasks').updateOne(
          { id },
          { $set: { id, t: t.t, d: t.d || '', s: t.s || 'todo', c: t.c || 0, w: t.w || '', n: t.n || '' } },
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
            { $set: { date, content: content.trim() } },
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
      { $set: { date, content: content.trim(), updatedAt: new Date().toISOString() } },
      { upsert: true }
    );
    res.json({ success: true, date, content: content.trim() });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao salvar anotação', details: err.message });
  }
});

// Exporta o app compatível com Vercel Serverless Functions
module.exports = app;
