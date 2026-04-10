import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import OpenAI from "openai";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import xlsx from "xlsx";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3000);
const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
const defaultModel = process.env.DEFAULT_MODEL || "gpt-4.1-mini";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors({ origin: allowedOrigin === "*" ? true : allowedOrigin }));
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }
});

function ensureApiKey() {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error("OPENAI_API_KEY não configurada no servidor.");
    error.statusCode = 500;
    throw error;
  }
}

function getOpenAIClient() {
  ensureApiKey();
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function cleanText(text) {
  return String(text || "")
    .replace(/\u0000/g, " ")
    .replace(/\r/g, "")
    .replace(/\t/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildAnalyzePrompt(content) {
  return `
Você é um tutor especialista em aprendizagem acelerada.

Analise o conteúdo abaixo e devolva em português do Brasil:
1. resumo objetivo
2. temas principais
3. tópicos mais importantes
4. tópicos mais difíceis
5. ordem ideal de estudo
6. pontos que merecem revisão
7. sugestões práticas de memorização e exercícios

Se o conteúdo estiver incompleto, avise isso claramente.

CONTEÚDO:
${content}
`.trim();
}

function buildPlanPrompt({ content, subjects, examDate, hoursPerDay }) {
  return `
Você é um planejador de estudos inteligente.

Monte um plano diário de estudo em português do Brasil com base no conteúdo enviado.

Dados do aluno:
- Matérias: ${subjects || "não informado"}
- Data da prova: ${examDate || "não informada"}
- Horas por dia: ${hoursPerDay || "não informado"}

Regras:
- priorize assuntos mais importantes e mais difíceis
- organize por sequência lógica
- inclua revisão espaçada
- inclua prática com questões
- seja objetivo e acionável
- devolva em JSON válido exatamente no formato abaixo

Formato JSON:
{
  "resumo_geral": "",
  "prioridades": ["", ""],
  "plano_diario": [
    {
      "dia": 1,
      "foco": "",
      "tarefas": ["", ""],
      "tempo_estimado": "",
      "revisao": "",
      "meta": ""
    }
  ]
}

CONTEÚDO:
${content}
`.trim();
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sheetToText(workbook) {
  const parts = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: "" });
    parts.push(`--- Aba: ${sheetName} ---`);
    for (const row of rows) {
      parts.push(row.map((cell) => String(cell)).join(" | "));
    }
    parts.push("");
  }
  return cleanText(parts.join("\n"));
}

async function extractTextFromFile(file) {
  if (!file) {
    throw new Error("Nenhum arquivo enviado.");
  }

  const mime = file.mimetype || "";
  const name = (file.originalname || "").toLowerCase();
  const buffer = file.buffer;

  if (mime.includes("pdf") || name.endsWith(".pdf")) {
    const parsed = await pdfParse(buffer);
    return cleanText(parsed.text);
  }

  if (mime.includes("wordprocessingml") || name.endsWith(".docx")) {
    const parsed = await mammoth.extractRawText({ buffer });
    return cleanText(parsed.value);
  }

  if (
    mime.includes("spreadsheetml") ||
    mime.includes("excel") ||
    name.endsWith(".xlsx") ||
    name.endsWith(".xls") ||
    name.endsWith(".csv")
  ) {
    const workbook = xlsx.read(buffer, { type: "buffer" });
    return sheetToText(workbook);
  }

  return cleanText(buffer.toString("utf8"));
}

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "vou-estudar-ia-real.html"));
});

app.get("/api/health", (_req, res) => {
  const configured = Boolean(process.env.OPENAI_API_KEY);
  res.json({
    ok: true,
    openai_configured: configured,
    default_model: defaultModel
  });
});

app.post("/api/extract-file", upload.single("file"), async (req, res) => {
  try {
    const text = await extractTextFromFile(req.file);

    if (!text) {
      return res.status(400).json({
        ok: false,
        error: "Não consegui extrair texto desse arquivo."
      });
    }

    return res.json({
      ok: true,
      filename: req.file.originalname,
      text
    });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: error.message || "Falha ao extrair texto do arquivo."
    });
  }
});

app.post("/api/study-ai", async (req, res) => {
  try {
    const client = getOpenAIClient();

    const { action, content, subjects, examDate, hoursPerDay, model } = req.body || {};
    const normalizedContent = cleanText(content);

    if (!normalizedContent) {
      return res.status(400).json({
        ok: false,
        error: "Conteúdo vazio. Cole ou importe um conteúdo primeiro."
      });
    }

    const normalizedAction = action === "plan" ? "plan" : "analyze";
    const selectedModel = cleanText(model) || defaultModel;

    const prompt =
      normalizedAction === "plan"
        ? buildPlanPrompt({
            content: normalizedContent,
            subjects: cleanText(subjects),
            examDate: cleanText(examDate),
            hoursPerDay: cleanText(hoursPerDay)
          })
        : buildAnalyzePrompt(normalizedContent);

    const response = await client.responses.create({
      model: selectedModel,
      input: prompt
    });

    const outputText = cleanText(response.output_text || "");
    const parsedJson = normalizedAction === "plan" ? tryParseJson(outputText) : null;

    return res.json({
      ok: true,
      action: normalizedAction,
      model: selectedModel,
      result: outputText,
      structured: parsedJson
    });
  } catch (error) {
    const statusCode = error.statusCode || error.status || 500;
    return res.status(statusCode).json({
      ok: false,
      error: error.message || "Erro interno ao processar IA."
    });
  }
});

app.listen(port, () => {
  console.log(`Servidor online rodando na porta ${port}`);
});
