# ⚡ Sistema de Tarefas: Vercel Direto para MongoDB Atlas

Arquitetura 100% **Serverless na Vercel**:
* **Frontend**: HTML5 + CSS + JavaScript servido na CDN global da Vercel (`public/index.html`).
* **API / Backend**: Vercel Serverless Function (`api/index.js`) que comunica **diretamente com o MongoDB Atlas** usando as variáveis de ambiente configuradas na Vercel (`.env`).
* **Sem servidores externos, sem VPS e sem outro backend.**

---

## 🚀 Como Fazer o Deploy na Vercel

### 1. Subir para o GitHub / GitLab / Bitbucket
Suba os arquivos deste projeto para o seu repositório.

### 2. Importar na Vercel
1. Acesse [vercel.com](https://vercel.com) e clique em **Add New... ➔ Project**.
2. Selecione o repositório do projeto.

### 3. Configurar as Variáveis de Ambiente no painel da Vercel
Na seção **Environment Variables**, adicione:

| Chave (Key) | Valor (Value) |
| :--- | :--- |
| **`MONGODB_URI`** | `mongodb+srv://suportesantaprint_db_user:3veKOgXWhx8NsCkv@cluster0.8njl4il.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0` |
| **`DB_NAME`** | `painel_tarefas_db` |

### 4. Concluir o Deploy
Clique no botão **Deploy**. Em poucos segundos o seu sistema estará no ar com HTTPS e conexão direta com o MongoDB Atlas.

---

## 📁 Estrutura Exclusiva Vercel

* [`api/index.js`](file:///c:/Users/Admin/3D%20Objects/Nova%20pasta/api/index.js): Função Serverless executada diretamente na infraestrutura da Vercel com conexão direta ao MongoDB Atlas.
* [`public/index.html`](file:///c:/Users/Admin/3D%20Objects/Nova%20pasta/public/index.html): Interface web moderna e responsiva (Calendário, Quadro Kanban, Anotações, Métricas e Backups).
* [`vercel.json`](file:///c:/Users/Admin/3D%20Objects/Nova%20pasta/vercel.json): Configuração de rotas da Vercel.
* [`package.json`](file:///c:/Users/Admin/3D%20Objects/Nova%20pasta/package.json): Dependências necessárias para a Serverless Function (`express`, `mongodb`, `dotenv`, `cors`).
* [`.env`](file:///c:/Users/Admin/3D%20Objects/Nova%20pasta/.env): Variáveis de ambiente para desenvolvimento local (via `npx vercel dev`).
* [`.gitignore`](file:///c:/Users/Admin/3D%20Objects/Nova%20pasta/.gitignore): Evita o envio de senhas para o repositório público.
