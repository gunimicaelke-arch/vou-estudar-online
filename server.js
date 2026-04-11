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
const paymentLink =
  process.env.PAYMENT_LINK ||
  "https://www.mercadopago.com.br/subscriptions/checkout?preapproval_plan_id=b27021920330458991fef9820c1acd53";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
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

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Vou Estudar+</title>
  <style>
    :root{
      --bg:#081120;
      --bg2:#0d1830;
      --card:#101c34;
      --card2:#13213d;
      --line:rgba(255,255,255,.08);
      --text:#eef6ff;
      --muted:#9eb6d6;
      --blue:#00d4ff;
      --purple:#7c5cff;
      --green:#35d6a7;
      --yellow:#ffd166;
      --danger:#ff6b81;
      --shadow:0 20px 50px rgba(0,0,0,.28);
    }

    *{box-sizing:border-box;margin:0;padding:0}

    body{
      font-family:Arial, Helvetica, sans-serif;
      background:
        radial-gradient(circle at top left, rgba(0,212,255,.10), transparent 28%),
        radial-gradient(circle at top right, rgba(124,92,255,.12), transparent 26%),
        linear-gradient(180deg, var(--bg), #091427 100%);
      color:var(--text);
      min-height:100vh;
    }

    .container{
      width:min(1180px, calc(100% - 24px));
      margin:0 auto;
      padding:20px 0 40px;
    }

    .hero{
      background:linear-gradient(145deg, rgba(16,28,52,.96), rgba(10,20,38,.98));
      border:1px solid var(--line);
      border-radius:28px;
      padding:26px;
      box-shadow:var(--shadow);
      margin-bottom:18px;
    }

    .hero-top{
      display:grid;
      grid-template-columns:1.1fr .9fr;
      gap:18px;
      align-items:start;
    }

    .badge{
      display:inline-block;
      padding:8px 14px;
      border-radius:999px;
      background:rgba(0,212,255,.10);
      border:1px solid rgba(0,212,255,.18);
      color:#8cecff;
      font-size:12px;
      font-weight:700;
      letter-spacing:.8px;
      margin-bottom:12px;
    }

    h1{
      font-size:clamp(30px,5vw,46px);
      line-height:1.05;
      margin-bottom:12px;
    }

    .subtitle{
      color:var(--muted);
      max-width:700px;
      line-height:1.65;
      font-size:15px;
    }

    .hero-actions{
      display:flex;
      gap:12px;
      flex-wrap:wrap;
      margin-top:20px;
    }

    button, .link-btn{
      border:none;
      cursor:pointer;
      border-radius:16px;
      padding:14px 18px;
      font-weight:800;
      text-decoration:none;
      display:inline-flex;
      align-items:center;
      justify-content:center;
      transition:.18s ease;
    }

    button:hover, .link-btn:hover{ transform:translateY(-1px); }

    .btn-primary{
      background:linear-gradient(135deg, var(--blue), #66ecff);
      color:#06111b;
      box-shadow:0 12px 28px rgba(0,212,255,.22);
    }

    .btn-success{
      background:linear-gradient(135deg, var(--green), #7df0cc);
      color:#062118;
    }

    .btn-secondary{
      background:rgba(255,255,255,.05);
      border:1px solid rgba(255,255,255,.08);
      color:var(--text);
    }

    .stats-preview{
      display:grid;
      grid-template-columns:repeat(2,1fr);
      gap:12px;
    }

    .preview-card{
      background:rgba(255,255,255,.04);
      border:1px solid rgba(255,255,255,.08);
      border-radius:20px;
      padding:16px;
      box-shadow:0 10px 22px rgba(0,0,0,.14);
    }

    .preview-card small{
      display:block;
      color:var(--muted);
      margin-bottom:8px;
      font-size:12px;
    }

    .preview-card strong{
      display:block;
      font-size:24px;
      margin-bottom:6px;
      color:#eef6ff;
    }

    .preview-card span{
      color:var(--muted);
      font-size:13px;
      line-height:1.5;
    }

    .dashboard-top{
      display:grid;
      grid-template-columns:repeat(4,1fr);
      gap:14px;
      margin-bottom:18px;
    }

    .metric-card{
      border-radius:20px;
      padding:18px;
      box-shadow:var(--shadow);
      border:1px solid rgba(255,255,255,.06);
    }

    .metric-card.blue{ background:linear-gradient(145deg, rgba(0,212,255,.16), rgba(16,28,52,.95)); }
    .metric-card.purple{ background:linear-gradient(145deg, rgba(124,92,255,.18), rgba(16,28,52,.95)); }
    .metric-card.green{ background:linear-gradient(145deg, rgba(53,214,167,.18), rgba(16,28,52,.95)); }
    .metric-card.yellow{ background:linear-gradient(145deg, rgba(255,209,102,.18), rgba(16,28,52,.95)); }

    .metric-label{
      display:block;
      font-size:13px;
      color:var(--muted);
      margin-bottom:8px;
    }

    .metric-card strong{
      display:block;
      font-size:30px;
      margin-bottom:6px;
    }

    .metric-card small{ color:#d8e7fb; }

    .section{
      background:linear-gradient(145deg, rgba(16,28,52,.96), rgba(10,20,38,.98));
      border:1px solid var(--line);
      border-radius:24px;
      padding:22px;
      box-shadow:var(--shadow);
      margin-bottom:18px;
    }

    .section h2{
      font-size:24px;
      margin-bottom:6px;
    }

    .section p.head{
      color:var(--muted);
      margin-bottom:18px;
      line-height:1.5;
    }

    .grid-2{
      display:grid;
      grid-template-columns:1.15fr .85fr;
      gap:16px;
    }

    .card{
      background:linear-gradient(145deg, rgba(19,33,61,.96), rgba(15,27,50,.98));
      border:1px solid rgba(255,255,255,.07);
      border-radius:22px;
      padding:18px;
      box-shadow:0 12px 30px rgba(0,0,0,.18);
    }

    .card h3{
      margin-bottom:12px;
      font-size:18px;
      color:#fff;
    }

    .field{ margin-bottom:14px; }

    label{
      display:block;
      font-size:13px;
      font-weight:700;
      margin-bottom:7px;
      color:#dcecff;
    }

    input, textarea, select{
      width:100%;
      background:rgba(255,255,255,.05);
      border:1px solid rgba(255,255,255,.08);
      color:var(--text);
      border-radius:16px;
      padding:14px;
      outline:none;
      font-size:14px;
    }

    input::placeholder, textarea::placeholder{ color:#8ea6c5; }

    textarea{
      min-height:180px;
      resize:vertical;
    }

    .row{
      display:grid;
      grid-template-columns:1fr 1fr;
      gap:12px;
    }

    .actions{
      display:flex;
      gap:10px;
      flex-wrap:wrap;
      margin-top:6px;
    }

    .result{
      min-height:120px;
      white-space:pre-wrap;
      line-height:1.6;
      color:#eef6ff;
    }

    .price-box{
      margin-top:18px;
      background:linear-gradient(145deg, rgba(0,212,255,.10), rgba(124,92,255,.10));
      border:1px solid rgba(0,212,255,.16);
      border-radius:18px;
      padding:18px;
      text-align:center;
    }

    .price-box h3{
      margin-bottom:8px;
      font-size:24px;
    }

    .price{
      font-size:40px;
      font-weight:900;
      margin-bottom:8px;
    }

    .price small{
      font-size:18px;
      color:#a8ddff;
    }

    .reward-panel{
      display:grid;
      grid-template-columns:repeat(4,1fr);
      gap:12px;
      margin-top:16px;
    }

    .reward-box{
      background:rgba(255,255,255,.04);
      border:1px solid var(--line);
      border-radius:18px;
      padding:16px;
      text-align:center;
    }

    .reward-label{
      display:block;
      color:var(--muted);
      font-size:13px;
      margin-bottom:8px;
    }

    .reward-box strong{ font-size:24px; }

    .chart-card{
      background:rgba(255,255,255,.04);
      border:1px solid var(--line);
      border-radius:18px;
      padding:18px;
      margin-top:16px;
    }

    .chart-card h3{ margin-bottom:6px; }

    .chart-card p{
      color:var(--muted);
      font-size:13px;
      margin-bottom:12px;
    }

    .chart-bars{
      height:210px;
      display:flex;
      align-items:flex-end;
      gap:12px;
    }

    .bar-wrap{
      flex:1;
      display:flex;
      flex-direction:column;
      align-items:center;
      gap:10px;
    }

    .bar{
      width:100%;
      max-width:42px;
      border-radius:14px 14px 6px 6px;
      box-shadow:0 10px 22px rgba(0,0,0,.18);
    }

    .bar.blue{ background:linear-gradient(180deg, var(--blue), #4eecff); }
    .bar.purple{ background:linear-gradient(180deg, var(--purple), #a791ff); }
    .bar.green{ background:linear-gradient(180deg, var(--green), #7df0ce); }

    .bar-wrap span{
      font-size:12px;
      color:var(--muted);
    }

    .resultado-cards{
      display:grid;
      grid-template-columns:repeat(2,1fr);
      gap:14px;
      margin-top:16px;
    }

    .resultado-card{
      background:linear-gradient(145deg, rgba(20,35,62,.96), rgba(14,27,49,.98));
      border:1px solid rgba(255,255,255,.07);
      border-radius:20px;
      padding:16px;
      box-shadow:0 10px 24px rgba(0,0,0,.14);
    }

    .resultado-tag{
      display:inline-block;
      font-size:12px;
      font-weight:800;
      color:#8cecff;
      background:rgba(0,212,255,.10);
      border:1px solid rgba(0,212,255,.14);
      padding:7px 10px;
      border-radius:999px;
      margin-bottom:10px;
    }

    .resultado-texto{
      color:var(--muted);
      line-height:1.7;
      font-size:14px;
      white-space:pre-wrap;
    }

    .work-list{
      display:grid;
      gap:12px;
      margin-top:14px;
    }

    .work-item{
      background:linear-gradient(145deg, rgba(20,35,62,.96), rgba(14,27,49,.98));
      border:1px solid rgba(255,255,255,.07);
      border-radius:18px;
      padding:16px;
      box-shadow:0 10px 24px rgba(0,0,0,.14);
    }

    .work-item strong{
      display:block;
      font-size:17px;
      margin-bottom:8px;
    }

    .work-meta{
      color:var(--muted);
      line-height:1.6;
      font-size:13px;
      margin-bottom:12px;
    }

    .pill{
      display:inline-block;
      padding:7px 12px;
      border-radius:999px;
      font-size:12px;
      font-weight:800;
      margin-bottom:10px;
    }

    .pill.pendente{
      background:rgba(255,209,102,.12);
      color:#ffe29a;
      border:1px solid rgba(255,209,102,.18);
    }

    .pill.andamento{
      background:rgba(0,212,255,.12);
      color:#8deaff;
      border:1px solid rgba(0,212,255,.18);
    }

    .pill.concluido{
      background:rgba(53,214,167,.12);
      color:#9df2d7;
      border:1px solid rgba(53,214,167,.18);
    }

    .status{
      margin-top:10px;
      font-size:13px;
      color:var(--muted);
    }

    .access-area{
      display:grid;
      grid-template-columns:1fr 1fr auto;
      gap:12px;
      align-items:end;
      margin-bottom:14px;
    }

    .overlay{
      position:fixed;
      inset:0;
      background:rgba(5,10,18,.86);
      backdrop-filter:blur(6px);
      display:none;
      align-items:center;
      justify-content:center;
      padding:18px;
      z-index:9999;
    }

    .overlay.active{ display:flex; }

    .overlay-box{
      width:min(520px,100%);
      background:linear-gradient(145deg, rgba(15,28,52,.98), rgba(8,18,35,.99));
      border:1px solid rgba(0,212,255,.18);
      border-radius:22px;
      padding:24px;
      text-align:center;
    }

    .overlay-box h3{
      font-size:26px;
      margin-bottom:10px;
    }

    .overlay-box p{
      color:var(--muted);
      line-height:1.6;
      margin-bottom:14px;
    }

    @media (max-width: 980px){
      .hero-top,
      .grid-2,
      .dashboard-top,
      .reward-panel,
      .resultado-cards{
        grid-template-columns:1fr 1fr;
      }
      .access-area{ grid-template-columns:1fr; }
    }

    @media (max-width: 680px){
      .container{
        width:min(100% - 14px, 100%);
      }
      .row,
      .dashboard-top,
      .reward-panel,
      .resultado-cards,
      .stats-preview{
        grid-template-columns:1fr;
      }
      .grid-2{ grid-template-columns:1fr; }
      .actions,
      .hero-actions{
        flex-direction:column;
      }
      button, .link-btn{ width:100%; }
    }
  </style>
</head>
<body>
  <div class="container">
    <section class="hero">
      <div class="hero-top">
        <div>
          <div class="badge">PLATAFORMA DE ESTUDO PREMIUM</div>
          <h1>Estude com mais organização, foco e resultado</h1>
          <div class="subtitle">
            Organize seu conteúdo, acompanhe seus trabalhos, monte estratégias para prova
            e mantenha sua rotina de estudo muito mais clara, bonita e motivadora.
          </div>

          <div class="hero-actions">
            <button class="btn-primary" onclick="irParaEstudo()">Começar agora</button>
            <a id="paymentBtnTop" class="link-btn btn-success" href="${paymentLink}" target="_blank" rel="noopener noreferrer">
              Assinar acesso
            </a>
          </div>
        </div>

        <div class="stats-preview">
          <div class="preview-card">
            <small>Plano de estudo</small>
            <strong>Organizado</strong>
            <span>metas claras e etapas objetivas</span>
          </div>

          <div class="preview-card">
            <small>Trabalhos</small>
            <strong>Em dia</strong>
            <span>prazos, lembretes e controle</span>
          </div>

          <div class="preview-card">
            <small>Progresso</small>
            <strong>Visual</strong>
            <span>gráficos e recompensa</span>
          </div>

          <div class="preview-card">
            <small>Rotina</small>
            <strong>Mais foco</strong>
            <span>menos bagunça, mais resultado</span>
          </div>
        </div>
      </div>
    </section>

    <div class="dashboard-top">
      <div class="metric-card blue">
        <span class="metric-label">Meta da semana</span>
        <strong>78%</strong>
        <small>evolução muito boa</small>
      </div>

      <div class="metric-card purple">
        <span class="metric-label">Sequência</span>
        <strong>9 dias</strong>
        <small>constância ativa</small>
      </div>

      <div class="metric-card green">
        <span class="metric-label">Trabalhos</span>
        <strong>12</strong>
        <small>5 concluídos</small>
      </div>

      <div class="metric-card yellow">
        <span class="metric-label">Próxima prova</span>
        <strong>3 dias</strong>
        <small>revisão intensiva</small>
      </div>
    </div>

    <section class="section" id="estudo">
      <h2>Estudo inteligente</h2>
      <p class="head">Conteúdo mais bem organizado, explicação clara e cronograma estratégico para prova.</p>

      <div class="access-area">
        <div class="field">
          <label for="email">Email</label>
          <input id="email" type="email" placeholder="Digite seu email">
        </div>

        <div class="field">
          <label for="nome">Nome</label>
          <input id="nome" type="text" placeholder="Digite seu nome">
        </div>

        <button class="btn-primary" onclick="iniciarAcesso()">Entrar</button>
      </div>

      <div id="loginStatus" class="status"></div>

      <div class="grid-2" style="margin-top:16px">
        <div class="card">
          <h3>Conteúdo principal</h3>

          <div class="field">
            <label for="materia">Matéria</label>
            <input id="materia" type="text" placeholder="Ex.: Direito Constitucional">
          </div>

          <div class="row">
            <div class="field">
              <label for="dataProva">Data da prova</label>
              <input id="dataProva" type="text" placeholder="25/05/2026">
            </div>
            <div class="field">
              <label for="diasPorSemana">Dias por semana</label>
              <input id="diasPorSemana" type="number" placeholder="5">
            </div>
          </div>

          <div class="field">
            <label for="horasPorDia">Horas por dia</label>
            <input id="horasPorDia" type="number" placeholder="2">
          </div>

          <div class="field">
            <label for="conteudo">Conteúdo</label>
            <textarea id="conteudo" placeholder="Cole aqui o PDF convertido ou o conteúdo para explicação e cronograma..."></textarea>
          </div>

          <div class="actions">
            <button class="btn-primary" onclick="explicarConteudo()">Explicar conteúdo</button>
            <button class="btn-success" onclick="gerarCronogramaProva()">Cronograma para prova</button>
            <button class="btn-secondary" onclick="importarArquivo()">Importar arquivo</button>
          </div>

          <div class="field" style="margin-top:14px;">
            <input id="arquivoConteudo" type="file">
          </div>
        </div>

        <div>
          <div class="card" id="assinatura">
            <h3>Assinatura mensal</h3>
            <p class="head" style="margin-bottom:12px">Acesso completo à plataforma com visual premium e organização total.</p>

            <div class="price-box" style="margin-top:0">
              <h3>Plano mensal</h3>
              <div class="price">R$ 20,00 <small>/mês</small></div>
              <a id="paymentBtn" class="link-btn btn-success" href="${paymentLink}" target="_blank" rel="noopener noreferrer">
                Assinar agora
              </a>
            </div>
          </div>

          <div class="chart-card">
            <h3>Progresso semanal</h3>
            <p>Visual simples para mostrar ritmo de estudo ao longo da semana.</p>

            <div class="chart-bars">
              <div class="bar-wrap"><div class="bar blue" style="height:42%"></div><span>Seg</span></div>
              <div class="bar-wrap"><div class="bar purple" style="height:74%"></div><span>Ter</span></div>
              <div class="bar-wrap"><div class="bar green" style="height:56%"></div><span>Qua</span></div>
              <div class="bar-wrap"><div class="bar blue" style="height:88%"></div><span>Qui</span></div>
              <div class="bar-wrap"><div class="bar purple" style="height:66%"></div><span>Sex</span></div>
              <div class="bar-wrap"><div class="bar green" style="height:35%"></div><span>Sáb</span></div>
              <div class="bar-wrap"><div class="bar blue" style="height:50%"></div><span>Dom</span></div>
            </div>
          </div>
        </div>
      </div>

      <div class="reward-panel">
        <div class="reward-box">
          <span class="reward-label">Pontuação</span>
          <strong>1250</strong>
        </div>
        <div class="reward-box">
          <span class="reward-label">Sequência</span>
          <strong>7 dias</strong>
        </div>
        <div class="reward-box">
          <span class="reward-label">Meta semanal</span>
          <strong>78%</strong>
        </div>
        <div class="reward-box">
          <span class="reward-label">Recompensa</span>
          <strong>Nível Prata</strong>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <h3>Resultado</h3>

        <div id="resultado" class="result">Aqui vai aparecer a explicação ou o cronograma da prova.</div>

        <div id="resultadoCards" class="resultado-cards" style="display:none;">
          <div class="resultado-card">
            <span class="resultado-tag">Temas prioritários</span>
            <div id="cardTemas" class="resultado-texto"></div>
          </div>

          <div class="resultado-card">
            <span class="resultado-tag">Chance de cair</span>
            <div id="cardChance" class="resultado-texto"></div>
          </div>

          <div class="resultado-card">
            <span class="resultado-tag">Cronograma</span>
            <div id="cardCronograma" class="resultado-texto"></div>
          </div>

          <div class="resultado-card">
            <span class="resultado-tag">Revisão e fixação</span>
            <div id="cardRevisao" class="resultado-texto"></div>
          </div>

          <div class="resultado-card">
            <span class="resultado-tag">Método mais eficiente</span>
            <div id="cardMetodo" class="resultado-texto"></div>
          </div>

          <div class="resultado-card">
            <span class="resultado-tag">Alerta final</span>
            <div id="cardAlerta" class="resultado-texto"></div>
          </div>
        </div>
      </div>
    </section>

    <section class="section">
      <h2>Gestão de trabalhos</h2>
      <p class="head">Cadastre atividades, organize prazos e acompanhe tudo de forma clara e bonita.</p>

      <div class="grid-2">
        <div class="card">
          <h3>Novo trabalho</h3>

          <div class="field">
            <label for="trabalhoTitulo">Título</label>
            <input id="trabalhoTitulo" type="text" placeholder="Título do trabalho">
          </div>

          <div class="field">
            <label for="trabalhoMateria">Matéria</label>
            <input id="trabalhoMateria" type="text" placeholder="Matéria">
          </div>

          <div class="row">
            <div class="field">
              <label for="trabalhoData">Data</label>
              <input id="trabalhoData" type="date">
            </div>
            <div class="field">
              <label for="trabalhoHora">Horário</label>
              <input id="trabalhoHora" type="time">
            </div>
          </div>

          <div class="row">
            <div class="field">
              <label for="trabalhoLembrete">Lembrete</label>
              <select id="trabalhoLembrete">
                <option>Sem lembrete</option>
                <option>No horário</option>
                <option>30 minutos antes</option>
                <option>1 hora antes</option>
                <option>1 dia antes</option>
              </select>
            </div>

            <div class="field">
              <label for="trabalhoStatus">Status</label>
              <select id="trabalhoStatus">
                <option>Pendente</option>
                <option>Em andamento</option>
                <option>Concluído</option>
              </select>
            </div>
          </div>

          <div class="field">
            <label for="trabalhoArquivo">Anexo</label>
            <input id="trabalhoArquivo" type="file">
          </div>

          <div class="actions">
            <button class="btn-success" onclick="salvarTrabalho()">Salvar trabalho</button>
            <button class="btn-secondary" onclick="carregarTrabalhos()">Atualizar lista</button>
          </div>
        </div>

        <div class="card">
          <h3>Lista de trabalhos</h3>
          <div id="listaTrabalhos" class="work-list"></div>
        </div>
      </div>
    </section>
  </div>

  <div id="overlay" class="overlay">
    <div class="overlay-box">
      <h3>Acesso necessário</h3>
      <p>Para continuar usando a plataforma completa, ative sua assinatura.</p>
      <div class="actions" style="justify-content:center;">
        <a id="overlayPaymentBtn" class="link-btn btn-success" href="${paymentLink}" target="_blank" rel="noopener noreferrer">
          Assinar agora
        </a>
        <button class="btn-secondary" onclick="consultarStatus()">Atualizar status</button>
      </div>
    </div>
  </div>

  <script>
    let currentEmail = "";
    let paymentLink = ${JSON.stringify(paymentLink)};

    function irParaEstudo(){
      const secao = document.querySelector("#estudo");
      if(secao){
        secao.scrollIntoView({ behavior: "smooth" });
      }
    }

    function limparResultadoCards(){
      document.getElementById("resultadoCards").style.display = "none";
      document.getElementById("cardTemas").textContent = "";
      document.getElementById("cardChance").textContent = "";
      document.getElementById("cardCronograma").textContent = "";
      document.getElementById("cardRevisao").textContent = "";
      document.getElementById("cardMetodo").textContent = "";
      document.getElementById("cardAlerta").textContent = "";
    }

    function setStatus(message){
      document.getElementById("loginStatus").textContent = message || "";
    }

    function setResultado(message){
      limparResultadoCards();
      document.getElementById("resultado").textContent = message || "";
    }

    function mostrarResultadoSimples(texto){
      limparResultadoCards();
      document.getElementById("resultado").textContent = texto || "";
    }

    function getEmail(){
      return document.getElementById("email").value.trim().toLowerCase();
    }

    function getNome(){
      return document.getElementById("nome").value.trim();
    }

    function updatePaymentButtons(){
      document.getElementById("paymentBtn").href = paymentLink || "#";
      document.getElementById("paymentBtnTop").href = paymentLink || "#";
      document.getElementById("overlayPaymentBtn").href = paymentLink || "#";
    }

    function showBlocked(){
      document.getElementById("overlay").classList.add("active");
    }

    function hideBlocked(){
      document.getElementById("overlay").classList.remove("active");
    }

    function extrairSecao(texto, inicio, proximosTitulos = []){
      const upper = texto.toUpperCase();
      const idxInicio = upper.indexOf(inicio.toUpperCase());
      if(idxInicio === -1) return "";

      let idxFim = texto.length;
      for(const titulo of proximosTitulos){
        const pos = upper.indexOf(titulo.toUpperCase(), idxInicio + inicio.length);
        if(pos !== -1 && pos < idxFim){
          idxFim = pos;
        }
      }
      return texto.slice(idxInicio + inicio.length, idxFim).trim();
    }

    function renderizarCardsCronograma(texto){
      if(!texto){
        mostrarResultadoSimples("Sem conteúdo para exibir.");
        return;
      }

      const temas = extrairSecao(texto, "1. TEMAS PRIORITÁRIOS", [
        "2. CHANCE DE CAIR NA PROVA", "2) CHANCE DE CAIR NA PROVA"
      ]);

      const chance = extrairSecao(texto, "2. CHANCE DE CAIR NA PROVA", [
        "3. CRONOGRAMA DE ESTUDO", "3) CRONOGRAMA DE ESTUDO"
      ]) || extrairSecao(texto, "2) CHANCE DE CAIR NA PROVA", [
        "3. CRONOGRAMA DE ESTUDO", "3) CRONOGRAMA DE ESTUDO"
      ]);

      const cronograma = extrairSecao(texto, "3. CRONOGRAMA DE ESTUDO", [
        "4. REVISÃO E FIXAÇÃO", "4) REVISÃO E FIXAÇÃO"
      ]) || extrairSecao(texto, "3) CRONOGRAMA DE ESTUDO", [
        "4. REVISÃO E FIXAÇÃO", "4) REVISÃO E FIXAÇÃO"
      ]);

      const revisao = extrairSecao(texto, "4. REVISÃO E FIXAÇÃO", [
        "5. MÉTODO MAIS EFICIENTE", "5) MÉTODO MAIS EFICIENTE"
      ]) || extrairSecao(texto, "4) REVISÃO E FIXAÇÃO", [
        "5. MÉTODO MAIS EFICIENTE", "5) MÉTODO MAIS EFICIENTE"
      ]);

      const metodo = extrairSecao(texto, "5. MÉTODO MAIS EFICIENTE", [
        "6. ALERTA FINAL", "6) ALERTA FINAL"
      ]) || extrairSecao(texto, "5) MÉTODO MAIS EFICIENTE", [
        "6. ALERTA FINAL", "6) ALERTA FINAL"
      ]);

      const alerta = extrairSecao(texto, "6. ALERTA FINAL", []) ||
                     extrairSecao(texto, "6) ALERTA FINAL", []);

      const encontrouBlocos = temas || chance || cronograma || revisao || metodo || alerta;
      if(!encontrouBlocos){
        mostrarResultadoSimples(texto);
        return;
      }

      document.getElementById("resultado").textContent = "";
      document.getElementById("resultadoCards").style.display = "grid";

      document.getElementById("cardTemas").textContent = temas || "Não identificado.";
      document.getElementById("cardChance").textContent = chance || "Não identificado.";
      document.getElementById("cardCronograma").textContent = cronograma || "Não identificado.";
      document.getElementById("cardRevisao").textContent = revisao || "Não identificado.";
      document.getElementById("cardMetodo").textContent = metodo || "Não identificado.";
      document.getElementById("cardAlerta").textContent = alerta || "Não identificado.";
    }

    async function iniciarAcesso(){
      const email = getEmail();
      const name = getNome();

      if(!email){
        setStatus("Digite seu email para entrar.");
        return;
      }

      try{
        const response = await fetch("/api/trial/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, name })
        });

        const data = await response.json();
        if(!data.ok){
          setStatus(data.mensagem || "Erro ao iniciar acesso.");
          return;
        }

        currentEmail = email;
        paymentLink = data.paymentLink || paymentLink || "#";
        updatePaymentButtons();
        hideBlocked();
        setStatus("Acesso iniciado com sucesso.");
        carregarTrabalhos();
      }catch{
        setStatus("Erro ao iniciar o acesso.");
      }
    }

    async function consultarStatus(){
      const email = getEmail();
      if(!email){
        setStatus("Digite seu email para verificar o acesso.");
        return;
      }

      try{
        const response = await fetch("/api/access-status?email=" + encodeURIComponent(email));
        const data = await response.json();

        if(!data.ok){
          setStatus(data.mensagem || "Erro ao consultar acesso.");
          return;
        }

        currentEmail = email;
        paymentLink = data.paymentLink || paymentLink || "#";
        updatePaymentButtons();

        if(data.blocked){
          showBlocked();
          setStatus("Seu acesso precisa ser liberado.");
        } else {
          hideBlocked();
          setStatus("Acesso liberado.");
          carregarTrabalhos();
        }
      }catch{
        setStatus("Erro ao consultar status.");
      }
    }

    function getHeaders(){
      return {
        "Content-Type": "application/json",
        "x-user-email": currentEmail
      };
    }

    function validarEmailAntes(){
      if(!currentEmail){
        setResultado("Digite o email e clique em 'Entrar' primeiro.");
        return false;
      }
      return true;
    }

    async function explicarConteudo(){
      if(!validarEmailAntes()) return;

      const conteudo = document.getElementById("conteudo").value.trim();
      const materia = document.getElementById("materia").value.trim();

      if(!conteudo){
        setResultado("Cole um conteúdo para explicar.");
        return;
      }

      setResultado("Explicando conteúdo...");

      try{
        const response = await fetch("/api/study-ai", {
          method: "POST",
          headers: getHeaders(),
          body: JSON.stringify({
            email: currentEmail,
            mode: "explain",
            materia,
            conteudo
          })
        });

        const data = await response.json();

        if(response.status === 403 && data.blocked){
          showBlocked();
          setResultado(data.mensagem || "Acesso bloqueado.");
          return;
        }

        mostrarResultadoSimples(
          data.resultado || data.mensagem || "Não foi possível explicar o conteúdo."
        );
      }catch{
        setResultado("Erro ao explicar conteúdo.");
      }
    }

    async function gerarCronogramaProva(){
      if(!validarEmailAntes()) return;

      const conteudo = document.getElementById("conteudo").value.trim();
      const materia = document.getElementById("materia").value.trim();
      const dataProva = document.getElementById("dataProva").value.trim();
      const diasPorSemana = document.getElementById("diasPorSemana").value.trim();
      const horasPorDia = document.getElementById("horasPorDia").value.trim();

      if(!conteudo){
        setResultado("Cole um conteúdo para montar o cronograma.");
        return;
      }

      setResultado("Montando cronograma para prova...");

      try{
        const response = await fetch("/api/study-ai", {
          method: "POST",
          headers: getHeaders(),
          body: JSON.stringify({
            email: currentEmail,
            mode: "plan",
            materia,
            conteudo,
            dataProva,
            diasPorSemana,
            horasPorDia
          })
        });

        const data = await response.json();

        if(response.status === 403 && data.blocked){
          showBlocked();
          setResultado(data.mensagem || "Acesso bloqueado.");
          return;
        }

        const textoFinal = data.resultado || data.mensagem || "Não foi possível montar o cronograma.";
        renderizarCardsCronograma(textoFinal);
      }catch{
        setResultado("Erro ao montar cronograma.");
      }
    }

    async function importarArquivo(){
      if(!validarEmailAntes()) return;

      const fileInput = document.getElementById("arquivoConteudo");
      const file = fileInput.files[0];

      if(!file){
        setResultado("Selecione um arquivo para importar.");
        return;
      }

      const formData = new FormData();
      formData.append("file", file);
      formData.append("email", currentEmail);

      setResultado("Importando conteúdo...");

      try{
        const response = await fetch("/api/extract-file", {
          method: "POST",
          headers: {
            "x-user-email": currentEmail
          },
          body: formData
        });

        const data = await response.json();

        if(response.status === 403 && data.blocked){
          showBlocked();
          setResultado(data.mensagem || "Acesso bloqueado.");
          return;
        }

        if(data.extractedText){
          document.getElementById("conteudo").value = data.extractedText;
          setResultado("Conteúdo importado com sucesso.");
        } else {
          setResultado(data.mensagem || "Não foi possível importar o arquivo.");
        }
      }catch{
        setResultado("Erro ao importar arquivo.");
      }
    }

    async function salvarTrabalho(){
      if(!validarEmailAntes()) return;

      const titulo = document.getElementById("trabalhoTitulo").value.trim();
      const materia = document.getElementById("trabalhoMateria").value.trim();
      const data = document.getElementById("trabalhoData").value;
      const hora = document.getElementById("trabalhoHora").value;
      const lembrete = document.getElementById("trabalhoLembrete").value;
      const status = document.getElementById("trabalhoStatus").value;
      const anexo = document.getElementById("trabalhoArquivo").files[0];

      if(!titulo){
        alert("Digite o título do trabalho.");
        return;
      }

      try{
        const response = await fetch("/api/trabalhos", {
          method: "POST",
          headers: getHeaders(),
          body: JSON.stringify({
            email: currentEmail,
            titulo,
            materia,
            data,
            hora,
            lembrete,
            status,
            anexoNome: anexo ? anexo.name : ""
          })
        });

        const dataResp = await response.json();

        if(response.status === 403 && dataResp.blocked){
          showBlocked();
          return;
        }

        if(!dataResp.ok){
          alert(dataResp.mensagem || "Erro ao salvar trabalho.");
          return;
        }

        document.getElementById("trabalhoTitulo").value = "";
        document.getElementById("trabalhoMateria").value = "";
        document.getElementById("trabalhoData").value = "";
        document.getElementById("trabalhoHora").value = "";
        document.getElementById("trabalhoLembrete").value = "Sem lembrete";
        document.getElementById("trabalhoStatus").value = "Pendente";
        document.getElementById("trabalhoArquivo").value = "";

        carregarTrabalhos();
      }catch{
        alert("Erro ao salvar trabalho.");
      }
    }

    async function carregarTrabalhos(){
      if(!currentEmail) return;

      const box = document.getElementById("listaTrabalhos");
      box.innerHTML = "<div class='status'>Carregando trabalhos...</div>";

      try{
        const response = await fetch("/api/trabalhos?email=" + encodeURIComponent(currentEmail), {
          headers: {
            "x-user-email": currentEmail
          }
        });

        const data = await response.json();

        if(response.status === 403 && data.blocked){
          showBlocked();
          box.innerHTML = "";
          return;
        }

        if(!data.ok){
          box.innerHTML = "<div class='status'>Não foi possível carregar.</div>";
          return;
        }

        if(!data.trabalhos.length){
          box.innerHTML = "<div class='status'>Nenhum trabalho cadastrado.</div>";
          return;
        }

        box.innerHTML = data.trabalhos.map(item => {
          const classe =
            item.status === "Concluído" ? "concluido" :
            item.status === "Em andamento" ? "andamento" : "pendente";

          return '<div class="work-item">' +
            '<div class="pill ' + classe + '">' + escapeHtml(item.status || "Pendente") + '</div>' +
            '<strong>' + escapeHtml(item.titulo) + '</strong>' +
            '<div class="work-meta">' +
            'Matéria: ' + escapeHtml(item.materia || "Não informada") + '<br>' +
            'Data: ' + escapeHtml(item.data || "-") + '<br>' +
            'Horário: ' + escapeHtml(item.hora || "-") + '<br>' +
            'Lembrete: ' + escapeHtml(item.lembrete || "-") + '<br>' +
            'Anexo: ' + escapeHtml(item.anexoNome || "Sem anexo") +
            '</div></div>';
        }).join("");
      }catch{
        box.innerHTML = "<div class='status'>Erro ao carregar trabalhos.</div>";
      }
    }

    function escapeHtml(text){
      return String(text ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    updatePaymentButtons();
  </script>
</body>
</html>`;

app.get("/", (req, res) => {
  res.type("html").send(html);
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
  console.log("Servidor rodando na porta " + port);
});
