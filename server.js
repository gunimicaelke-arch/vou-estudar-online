import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import OpenAI from "openai";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import xlsx from "xlsx";

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3000);
const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
const defaultModel = process.env.DEFAULT_MODEL || "gpt-4.1-mini";
const paymentLink = process.env.PAYMENT_LINK || "#";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const INDEX_FILE = path.join(__dirname, "index.html");

const TRIAL_DAYS = 3;

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(
    DB_FILE,
    JSON.stringify(
      {
        users: [],
        trabalhos: [],
        conteudos: []
      },
      null,
      2
    ),
    "utf-8"
  );
}

function loadDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
  } catch {
    return { users: [], trabalhos: [], conteudos: [] };
  }
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf-8");
}

function nowISO() {
  return new Date().toISOString();
}

function makeId(prefix = "id") {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}

function cortarTexto(texto = "", limite = 3000) {
  if (typeof texto !== "string") return "";
  return texto.trim().slice(0, limite);
}

function daysBetween(startISO, endDate = new Date()) {
  const start = new Date(startISO);
  const diff = endDate.getTime() - start.getTime();
  return diff / (1000 * 60 * 60 * 24);
}

function isTrialExpired(user) {
  if (!user?.trialStartedAt) return false;
  if (user.subscriptionActive) return false;
  return daysBetween(user.trialStartedAt) >= TRIAL_DAYS;
}

function remainingTrialDays(user) {
  if (!user?.trialStartedAt) return TRIAL_DAYS;
  const used = daysBetween(user.trialStartedAt);
  return Math.max(0, Math.ceil(TRIAL_DAYS - used));
}

function getOrCreateUser(email, name = "Aluno") {
  const db = loadDB();
  const normalizedEmail = String(email).trim().toLowerCase();

  let user = db.users.find(
    (u) => String(u.email).trim().toLowerCase() === normalizedEmail
  );

  if (!user) {
    user = {
      id: makeId("user"),
      name: name || "Aluno",
      email: normalizedEmail,
      createdAt: nowISO(),
      trialStartedAt: nowISO(),
      subscriptionActive: false,
      plan: "teste"
    };
    db.users.push(user);
    saveDB(db);
  }

  return user;
}

function updateUser(email, updater) {
  const db = loadDB();
  const normalizedEmail = String(email).trim().toLowerCase();
  const index = db.users.findIndex(
    (u) => String(u.email).trim().toLowerCase() === normalizedEmail
  );

  if (index === -1) return null;

  db.users[index] = { ...db.users[index], ...updater };
  saveDB(db);
  return db.users[index];
}

function extrairTextoDoResponse(response) {
  if (response?.output_text) return response.output_text;

  try {
    const textos = [];
    for (const item of response?.output || []) {
      for (const content of item?.content || []) {
        if (content?.type === "output_text" && content?.text) {
          textos.push(content.text);
        }
      }
    }
    return textos.join("\n").trim();
  } catch {
    return "";
  }
}

async function extrairTextoArquivo(file) {
  const nome = (file.originalname || "").toLowerCase();
  const mime = (file.mimetype || "").toLowerCase();
  const buffer = file.buffer;

  if (mime.includes("pdf") || nome.endsWith(".pdf")) {
    const data = await pdfParse(buffer);
    return data.text || "";
  }

  if (
    mime.includes("word") ||
    mime.includes("officedocument.wordprocessingml") ||
    nome.endsWith(".docx")
  ) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || "";
  }

  if (
    mime.includes("sheet") ||
    mime.includes("excel") ||
    nome.endsWith(".xlsx") ||
    nome.endsWith(".xls") ||
    nome.endsWith(".csv")
  ) {
    const workbook = xlsx.read(buffer, { type: "buffer" });
    const partes = [];

    workbook.SheetNames.forEach((sheetName) => {
      const ws = workbook.Sheets[sheetName];
      const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: "" });
      const text = rows.map((row) => row.join(" | ")).join("\n");
      partes.push(`Planilha: ${sheetName}\n${text}`);
    });

    return partes.join("\n\n");
  }

  if (
    mime.startsWith("text/") ||
    nome.endsWith(".txt") ||
    nome.endsWith(".md")
  ) {
    return buffer.toString("utf-8");
  }

  throw new Error("Formato de arquivo não suportado.");
}

function tratarErroOpenAI(err, res) {
  console.error("Erro OpenAI:", err);

  const status = err?.status || err?.code || 500;
  const detalhe =
    err?.error?.message || err?.message || "Erro interno ao acessar o serviço.";

  if (status === 429) {
    return res.status(429).json({
      ok: false,
      tipo: "quota",
      mensagem: "Limite de uso atingido no momento.",
      detalhe
    });
  }

  if (status === 401) {
    return res.status(401).json({
      ok: false,
      tipo: "auth",
      mensagem: "Chave do serviço inválida ou ausente.",
      detalhe
    });
  }

  return res.status(500).json({
    ok: false,
    tipo: "server",
    mensagem: "Erro ao processar a solicitação.",
    detalhe
  });
}

function requireAccess(req, res, next) {
  const email = String(
    req.headers["x-user-email"] || req.body?.email || req.query?.email || ""
  ).trim();

  const name = String(req.body?.name || req.query?.name || "Aluno").trim();

  if (!email) {
    return res.status(400).json({
      ok: false,
      mensagem: "Email do usuário não enviado."
    });
  }

  const user = getOrCreateUser(email, name);

  if (isTrialExpired(user)) {
    return res.status(403).json({
      ok: false,
      blocked: true,
      motivo: "trial_expired",
      mensagem: "Seu período de teste terminou. Assine para continuar.",
      trialRemainingDays: 0,
      subscriptionActive: user.subscriptionActive,
      paymentLink
    });
  }

  req.user = user;
  next();
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

app.use(cors({ origin: allowedOrigin === "*" ? true : allowedOrigin }));
app.use(express.json({ limit: "6mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.get("/", (req, res) => {
  res.sendFile(INDEX_FILE);
});

app.get("/api/health", (req, res) => {
  const db = loadDB();
  res.json({
    ok: true,
    status: "online",
    users: db.users.length,
    trabalhos: db.trabalhos.length,
    conteudos: db.conteudos.length,
    hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
    paymentLinkConfigured: paymentLink !== "#",
    model: defaultModel
  });
});

app.post("/api/trial/start", (req, res) => {
  const email = String(req.body?.email || "").trim();
  const name = String(req.body?.name || "Aluno").trim();

  if (!email) {
    return res.status(400).json({
      ok: false,
      mensagem: "Email é obrigatório."
    });
  }

  const user = getOrCreateUser(email, name);

  return res.json({
    ok: true,
    user,
    trialRemainingDays: remainingTrialDays(user),
    subscriptionActive: user.subscriptionActive,
    paymentLink
  });
});

app.get("/api/access-status", (req, res) => {
  const email = String(req.query?.email || "").trim();

  if (!email) {
    return res.status(400).json({
      ok: false,
      mensagem: "Email é obrigatório."
    });
  }

  const user = getOrCreateUser(email);

  return res.json({
    ok: true,
    email: user.email,
    subscriptionActive: user.subscriptionActive,
    plan: user.plan,
    blocked: isTrialExpired(user),
    trialRemainingDays: remainingTrialDays(user),
    trialStartedAt: user.trialStartedAt,
    paymentLink
  });
});

app.post("/api/subscription/activate", (req, res) => {
  const email = String(req.body?.email || "").trim();
  const plan = String(req.body?.plan || "premium").trim();

  if (!email) {
    return res.status(400).json({
      ok: false,
      mensagem: "Email é obrigatório."
    });
  }

  getOrCreateUser(email);
  const updated = updateUser(email, {
    subscriptionActive: true,
    plan
  });

  return res.json({
    ok: true,
    mensagem: "Assinatura ativada com sucesso.",
    user: updated
  });
});

app.post("/api/subscription/deactivate", (req, res) => {
  const email = String(req.body?.email || "").trim();

  if (!email) {
    return res.status(400).json({
      ok: false,
      mensagem: "Email é obrigatório."
    });
  }

  const updated = updateUser(email, {
    subscriptionActive: false,
    plan: "teste"
  });

  return res.json({
    ok: true,
    mensagem: "Assinatura desativada.",
    user: updated
  });
});

app.post("/api/extract-file", requireAccess, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        mensagem: "Nenhum arquivo enviado."
      });
    }

    const texto = await extrairTextoArquivo(req.file);
    const textoLimpo = cortarTexto(texto, 12000);

    const db = loadDB();
    db.conteudos.unshift({
      id: makeId("content"),
      userEmail: req.user.email,
      fileName: req.file.originalname,
      extractedText: textoLimpo,
      createdAt: nowISO()
    });
    saveDB(db);

    return res.json({
      ok: true,
      fileName: req.file.originalname,
      extractedText: textoLimpo
    });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      mensagem: error.message || "Erro ao extrair arquivo."
    });
  }
});

app.post("/api/study-ai", requireAccess, async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        ok: false,
        mensagem: "OPENAI_API_KEY não configurada."
      });
    }

    const mode = String(req.body?.mode || "explain").toLowerCase();
    const materia = cortarTexto(req.body?.materia || "", 100);
    const conteudo = cortarTexto(req.body?.conteudo || "", 12000);
    const dataProva = cortarTexto(req.body?.dataProva || "", 40);
    const diasPorSemana = cortarTexto(String(req.body?.diasPorSemana || ""), 20);
    const horasPorDia = cortarTexto(String(req.body?.horasPorDia || ""), 20);

    if (!conteudo && mode !== "test") {
      return res.status(400).json({
        ok: false,
        mensagem: "Conteúdo é obrigatório."
      });
    }

    let input = "";
    let max_output_tokens = 900;

    if (mode === "test") {
      input = "Responda apenas: conexão ok";
      max_output_tokens = 20;
    } else if (mode === "explain") {
      input = `
Você é um professor particular claro e didático.

Sua função é explicar o conteúdo enviado de forma simples, organizada e útil para estudo.

Objetivo:
- explicar os pontos principais
- mostrar os conceitos centrais
- organizar a resposta em blocos curtos
- evitar texto longo e bagunçado

Quero a resposta neste formato:

1. VISÃO GERAL
2. PONTOS PRINCIPAIS
3. O QUE O ALUNO PRECISA ENTENDER DE VERDADE
4. EXPLICAÇÃO SIMPLES
5. DICA DE FIXAÇÃO

Regras:
- usar português do Brasil
- ser claro e objetivo
- não fazer resumo genérico de livro
- organizar o conteúdo em partes curtas
- explicar como professor

Matéria: ${materia || "Não informada"}

Conteúdo:
${conteudo}
      `;
      max_output_tokens = 850;
    } else if (mode === "plan") {
      input = `
Você é um especialista em preparação para provas.

Sua função NÃO é fazer resumo genérico.
Sua função é analisar o conteúdo enviado e montar um cronograma de estudo estratégico.

Objetivo:
- identificar os pontos mais importantes do material
- destacar os temas com maior chance de cair na prova
- organizar um cronograma de estudo prático
- mostrar o que estudar primeiro, depois e por último
- sugerir o melhor método de estudo para cada etapa
- considerar como mais prováveis os conceitos centrais, definições, classificações, etapas, exceções, comparações e tópicos repetidos no material

Dados do aluno:
- Matéria: ${materia || "Não informada"}
- Data da prova: ${dataProva || "Não informada"}
- Dias por semana disponíveis: ${diasPorSemana || "Não informado"}
- Horas por dia: ${horasPorDia || "Não informado"}

Quero a resposta neste formato exato:

1. TEMAS PRIORITÁRIOS
- liste os tópicos mais importantes

2. CHANCE DE CAIR NA PROVA
- Muito alta
- Alta
- Média

3. CRONOGRAMA DE ESTUDO
- dividir por dias ou etapas
- organizar a sequência do estudo

4. REVISÃO E FIXAÇÃO
- quando revisar
- como revisar

5. MÉTODO MAIS EFICIENTE
- dizer como estudar esse conteúdo de forma mais forte para prova

6. ALERTA FINAL
- o que o aluno não pode deixar de estudar

Regras:
- não fazer texto longo e misturado
- ser objetivo e organizado
- focar em prova
- transformar o conteúdo em estratégia de estudo
- se o conteúdo for grande, priorizar os pontos centrais
- usar português do Brasil
- deixar visualmente fácil de ler

Conteúdo:
${conteudo}
      `;
      max_output_tokens = 1100;
    } else {
      input = `
Explique o conteúdo abaixo de forma clara, objetiva e organizada em português do Brasil.

Matéria: ${materia || "Não informada"}

Conteúdo:
${conteudo}
      `;
      max_output_tokens = 700;
    }

    const response = await openai.responses.create({
      model: defaultModel,
      input,
      max_output_tokens
    });

    const resultado = extrairTextoDoResponse(response);

    const db = loadDB();
    db.conteudos.unshift({
      id: makeId("ai"),
      userEmail: req.user.email,
      mode,
      materia,
      conteudo,
      resultado,
      createdAt: nowISO()
    });
    saveDB(db);

    return res.json({
      ok: true,
      resultado
    });
  } catch (err) {
    return tratarErroOpenAI(err, res);
  }
});

app.post("/api/trabalhos", requireAccess, (req, res) => {
  const db = loadDB();

  const trabalho = {
    id: makeId("work"),
    userEmail: req.user.email,
    titulo: cortarTexto(req.body?.titulo || "", 160),
    materia: cortarTexto(req.body?.materia || "", 100),
    data: cortarTexto(req.body?.data || "", 30),
    hora: cortarTexto(req.body?.hora || "", 20),
    lembrete: cortarTexto(req.body?.lembrete || "Sem lembrete", 40),
    status: cortarTexto(req.body?.status || "Pendente", 40),
    anexoNome: cortarTexto(req.body?.anexoNome || "", 200),
    createdAt: nowISO()
  };

  if (!trabalho.titulo) {
    return res.status(400).json({
      ok: false,
      mensagem: "Título é obrigatório."
    });
  }

  db.trabalhos.unshift(trabalho);
  saveDB(db);

  return res.json({
    ok: true,
    trabalho
  });
});

app.get("/api/trabalhos", requireAccess, (req, res) => {
  const db = loadDB();
  const lista = db.trabalhos.filter((t) => t.userEmail === req.user.email);

  return res.json({
    ok: true,
    trabalhos: lista
  });
});

app.delete("/api/trabalhos/:id", requireAccess, (req, res) => {
  const db = loadDB();
  const id = String(req.params.id);
  const antes = db.trabalhos.length;

  db.trabalhos = db.trabalhos.filter(
    (t) => !(t.id === id && t.userEmail === req.user.email)
  );

  saveDB(db);

  return res.json({
    ok: true,
    removido: antes !== db.trabalhos.length
  });
});

app.patch("/api/trabalhos/:id/concluir", requireAccess, (req, res) => {
  const db = loadDB();
  const id = String(req.params.id);

  const index = db.trabalhos.findIndex(
    (t) => t.id === id && t.userEmail === req.user.email
  );

  if (index === -1) {
    return res.status(404).json({
      ok: false,
      mensagem: "Trabalho não encontrado."
    });
  }

  db.trabalhos[index].status = "Concluído";
  saveDB(db);

  return res.json({
    ok: true,
    trabalho: db.trabalhos[index]
  });
});

app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});
