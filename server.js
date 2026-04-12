require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const mammoth = require("mammoth");
const XLSX = require("xlsx");
const OpenAI = require("openai");

const app = express();
const PORT = process.env.PORT || 3000;

const upload = multer({ storage: multer.memoryStorage() });

const DATA_DIR = path.join(__dirname, "data");
const APP_STATE_FILE = path.join(DATA_DIR, "app-state.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(__dirname));

function getDefaultState() {
  return {
    metrics: {
      horasSemana: [0, 0, 0, 0, 0, 0, 0],
      evolucaoConteudos: [0, 0, 0, 0, 0, 0, 0],
      diasSemana: ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"],
      materias: [],
      valoresMaterias: [],
      progressoConcluido: 0,
      progressoFaltando: 0,
      totalConteudos: 0,
      totalMeta: 0,
      sequencia: 0,
      ultimaDataEstudo: "",
      weekGoal: 0,
      manualCompleted: 0,
      planTarget: 0,
      planSubjectCounts: {}
    },
    schedules: [],
    reminders: [],
    studyTimer: {
      activeSubject: "",
      isRunning: false,
      startedAt: null,
      currentSessionSeconds: 0,
      subjects: {}
    },
    form: {
      aiEndpoint: "/api/study-ai",
      aiModel: process.env.DEFAULT_MODEL || "gpt-4.1-mini",
      scheduleTitle: "",
      subjects: "",
      examDate: "",
      hoursPerDay: "",
      content: ""
    },
    result: "",
    currentStructuredPlan: null
  };
}

function readAppState() {
  try {
    if (!fs.existsSync(APP_STATE_FILE)) {
      return getDefaultState();
    }

    const raw = fs.readFileSync(APP_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    return {
      ...getDefaultState(),
      ...parsed,
      metrics: {
        ...getDefaultState().metrics,
        ...(parsed.metrics || {})
      },
      studyTimer: {
        ...getDefaultState().studyTimer,
        ...(parsed.studyTimer || {})
      },
      form: {
        ...getDefaultState().form,
        ...(parsed.form || {})
      }
    };
  } catch (error) {
    console.error("Erro ao ler app-state:", error.message);
    return getDefaultState();
  }
}

function writeAppState(data) {
  fs.writeFileSync(APP_STATE_FILE, JSON.stringify(data, null, 2), "utf8");
}

function safeString(value) {
  return String(value || "").trim();
}

function buildAnalyzePrompt({ content, subjects, examDate, hoursPerDay }) {
  return `
Analise o conteúdo abaixo de forma clara, prática e organizada para estudo.

DADOS:
- Matérias: ${subjects || "Não informado"}
- Data da prova: ${examDate || "Não informada"}
- Horas por dia: ${hoursPerDay || "Não informado"}

OBJETIVO:
- resumir os pontos principais
- identificar os temas mais importantes
- apontar temas com maior chance de cobrança
- destacar o que exige mais atenção
- sugerir uma estratégia prática de estudo
- responder em português do Brasil
- evitar enrolação

CONTEÚDO:
${content}
`.trim();
}

function buildPlanPrompt({ content, subjects, examDate, hoursPerDay, excellent }) {
  return `
Monte um ${excellent ? "PLANO EXCELENTE DE ESTUDO" : "plano diário de estudo"} em português do Brasil.

DADOS:
- Matérias: ${subjects || "Não informado"}
- Data da prova: ${examDate || "Não informada"}
- Horas por dia: ${hoursPerDay || "Não informado"}

${excellent ? `
OBJETIVO:
Criar um plano premium, estratégico, claro, forte, útil para alto desempenho e retenção.

REGRAS OBRIGATÓRIAS:
- dividir em dias
- priorizar assuntos mais importantes e difíceis
- equilibrar teoria, revisão ativa e prática
- incluir revisão espaçada
- incluir exercícios e questões
- incluir metas claras por dia
- indicar foco principal do dia
- organizar a carga de forma inteligente
- evitar plano genérico
- responder em português do Brasil
- deixar o plano didático, forte e realmente útil para prova
` : `
REGRAS:
- dividir em dias
- organizar por prioridade
- equilibrar teoria, revisão e prática
- incluir revisão recorrente
- incluir exercícios quando fizer sentido
- responder em português do Brasil
`}

RETORNE EM 2 PARTES:

PARTE 1 - TEXTO EXPLICATIVO
Explique brevemente a lógica do plano.

PARTE 2 - JSON VÁLIDO
Retorne exatamente neste formato:
{
  "plano_diario": [
    {
      "dia": 1,
      "foco": "Assunto principal do dia",
      "tempo_estimado": "2 horas",
      "meta": "Objetivo claro do dia",
      "revisao": "O que revisar neste dia",
      "tarefas": [
        "Tarefa 1 detalhada",
        "Tarefa 2 detalhada",
        "Tarefa 3 detalhada"
      ]
    }
  ]
}

IMPORTANTE:
- o JSON deve ser válido
- a parte explicativa vem antes
- depois do texto explicativo, escreva o JSON completo
- não escreva texto extra depois do JSON

CONTEÚDO:
${content}
`.trim();
}

function extractStructuredPlan(result) {
  try {
    const jsonMatch = result.match(/\{[\s\S]*"plano_diario"[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);

    if (!parsed || !Array.isArray(parsed.plano_diario)) {
      return null;
    }

    return parsed;
  } catch (error) {
    console.error("Erro ao extrair JSON do plano:", error.message);
    return null;
  }
}

function extractTextFromExcel(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const parts = [];

  workbook.SheetNames.forEach((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

    parts.push(`--- PLANILHA: ${sheetName} ---`);
    rows.forEach((row) => {
      const line = row.map((cell) => String(cell ?? "").trim()).filter(Boolean).join(" | ");
      if (line) parts.push(line);
    });
    parts.push("");
  });

  return parts.join("\n").trim();
}

async function extractTextFromDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return safeString(result.value);
}

function extractTextFromPlain(buffer) {
  return buffer.toString("utf8");
}

function extractTextByExtension(filename, buffer) {
  const ext = path.extname(filename || "").toLowerCase();

  if (ext === ".txt" || ext === ".md" || ext === ".html" || ext === ".json" || ext === ".csv") {
    return Promise.resolve(extractTextFromPlain(buffer));
  }

  if (ext === ".xlsx" || ext === ".xls") {
    return Promise.resolve(extractTextFromExcel(buffer));
  }

  if (ext === ".docx") {
    return extractTextFromDocx(buffer);
  }

  if (ext === ".pdf") {
    return Promise.resolve(
      "Arquivo PDF recebido. Para leitura completa de PDF no backend, instale um extrator de PDF no servidor. No momento, use TXT, DOCX, XLSX ou cole o conteúdo manualmente."
    );
  }

  return Promise.resolve(extractTextFromPlain(buffer));
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    openai_configured: !!process.env.OPENAI_API_KEY,
    default_model: process.env.DEFAULT_MODEL || "gpt-4.1-mini"
  });
});

app.get("/api/app-state", (req, res) => {
  try {
    const state = readAppState();
    res.json({ ok: true, state });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: "Erro ao carregar estado do sistema."
    });
  }
});

app.post("/api/app-state", (req, res) => {
  try {
    const incoming = req.body || {};
    const merged = {
      ...getDefaultState(),
      ...incoming,
      metrics: {
        ...getDefaultState().metrics,
        ...(incoming.metrics || {})
      },
      studyTimer: {
        ...getDefaultState().studyTimer,
        ...(incoming.studyTimer || {})
      },
      form: {
        ...getDefaultState().form,
        ...(incoming.form || {})
      }
    };

    writeAppState(merged);

    res.json({ ok: true });
  } catch (error) {
    console.error("Erro ao salvar app-state:", error.message);
    res.status(500).json({
      ok: false,
      error: "Erro ao salvar estado do sistema."
    });
  }
});

app.post("/api/extract-file", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "Nenhum arquivo enviado."
      });
    }

    const text = await extractTextByExtension(req.file.originalname, req.file.buffer);

    res.json({
      ok: true,
      filename: req.file.originalname,
      text: text || ""
    });
  } catch (error) {
    console.error("Erro ao extrair arquivo:", error.message);
    res.status(500).json({
      ok: false,
      error: "Erro ao extrair texto do arquivo."
    });
  }
});

app.post("/api/study-ai", async (req, res) => {
  try {
    const {
      action,
      model,
      content,
      subjects,
      examDate,
      hoursPerDay,
      promptMode
    } = req.body || {};

    const subjectsText = safeString(subjects);
    const examDateText = safeString(examDate);
    const hoursPerDayText = safeString(hoursPerDay);
    const contentText = safeString(content);

    if (!contentText) {
      return res.status(400).json({
        ok: false,
        error: "Conteúdo vazio."
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "OPENAI_API_KEY não configurada no servidor."
      });
    }

    const isExcellentPlan = action === "excellent_plan" || promptMode === "excellent";

    let userPrompt = "";

    if (action === "analyze") {
      userPrompt = buildAnalyzePrompt({
        content: contentText,
        subjects: subjectsText,
        examDate: examDateText,
        hoursPerDay: hoursPerDayText
      });
    } else if (action === "plan" || action === "excellent_plan") {
      userPrompt = buildPlanPrompt({
        content: contentText,
        subjects: subjectsText,
        examDate: examDateText,
        hoursPerDay: hoursPerDayText,
        excellent: isExcellentPlan
      });
    } else {
      return res.status(400).json({
        ok: false,
        error: "Ação inválida."
      });
    }

    const completion = await openai.chat.completions.create({
      model: model || process.env.DEFAULT_MODEL || "gpt-4.1-mini",
      temperature: isExcellentPlan ? 0.7 : 0.5,
      messages: [
        {
          role: "system",
          content: `
Você é um planejador de estudos altamente organizado.
Responda sempre em português do Brasil.
Se o usuário pedir plano de estudo, entregue conteúdo útil, claro e bem estruturado.
Se precisar retornar JSON, ele deve ser válido.
`.trim()
        },
        {
          role: "user",
          content: userPrompt
        }
      ]
    });

    const result = completion.choices?.[0]?.message?.content || "";
    const structured = extractStructuredPlan(result);

    res.json({
      ok: true,
      model: model || process.env.DEFAULT_MODEL || "gpt-4.1-mini",
      result,
      structured
    });
  } catch (error) {
    console.error("Erro em /api/study-ai:", error);

    res.status(500).json({
      ok: false,
      error: error?.message || "Erro interno ao processar a solicitação."
    });
  }
});

app.get("*", (req, res) => {
  const publicIndex = path.join(__dirname, "public", "index.html");
  const rootIndex = path.join(__dirname, "index.html");

  if (fs.existsSync(publicIndex)) {
    return res.sendFile(publicIndex);
  }

  if (fs.existsSync(rootIndex)) {
    return res.sendFile(rootIndex);
  }

  return res.status(404).send("index.html não encontrado.");
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
