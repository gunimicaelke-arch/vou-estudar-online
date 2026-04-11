import express from "express";
import cors from "cors";
import dotenv from "dotenv";
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "gpt-4.1-mini";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024, // 20 MB
  },
});

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN || "*",
  })
);

app.use(express.static(__dirname));

function cleanText(text = "") {
  return String(text)
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    try {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
      return null;
    } catch {
      return null;
    }
  }
}

function formatStructuredResult(data) {
  if (!data || typeof data !== "object") {
    return "Não foi possível estruturar a resposta da IA.";
  }

  const lines = [];

  if (data.titulo) {
    lines.push(`# ${data.titulo}`);
    lines.push("");
  }

  if (data.resumo) {
    lines.push(`## Resumo`);
    lines.push(data.resumo);
    lines.push("");
  }

  if (Array.isArray(data.pontos_chave) && data.pontos_chave.length) {
    lines.push(`## Pontos-chave`);
    for (const item of data.pontos_chave) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }

  if (Array.isArray(data.topicos_prioritarios) && data.topicos_prioritarios.length) {
    lines.push(`## Tópicos prioritários`);
    for (const item of data.topicos_prioritarios) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }

  if (Array.isArray(data.cronograma_por_materia) && data.cronograma_por_materia.length) {
    lines.push(`## Cronograma por matéria`);
    for (const materia of data.cronograma_por_materia) {
      lines.push(`### ${materia.materia || "Matéria"}`);
      if (materia.objetivo) lines.push(`Objetivo: ${materia.objetivo}`);
      if (materia.horas_sugeridas) lines.push(`Horas sugeridas: ${materia.horas_sugeridas}`);
      if (Array.isArray(materia.topicos) && materia.topicos.length) {
        lines.push(`Tópicos:`);
        for (const topico of materia.topicos) {
          lines.push(`- ${topico}`);
        }
      }
      lines.push("");
    }
  }

  if (Array.isArray(data.plano_de_estudo) && data.plano_de_estudo.length) {
    lines.push(`## Plano de estudo`);
    for (const etapa of data.plano_de_estudo) {
      lines.push(`### ${etapa.dia || etapa.etapa || "Etapa"}`);
      if (etapa.foco) lines.push(`Foco: ${etapa.foco}`);
      if (etapa.tempo_estimado) lines.push(`Tempo estimado: ${etapa.tempo_estimado}`);
      if (Array.isArray(etapa.tarefas) && etapa.tarefas.length) {
        lines.push(`Tarefas:`);
        for (const tarefa of etapa.tarefas) {
          lines.push(`- ${tarefa}`);
        }
      }
      lines.push("");
    }
  }

  if (Array.isArray(data.revisoes) && data.revisoes.length) {
    lines.push(`## Revisões`);
    for (const item of data.revisoes) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }

  if (Array.isArray(data.questoes_sugeridas) && data.questoes_sugeridas.length) {
    lines.push(`## Questões sugeridas`);
    for (const item of data.questoes_sugeridas) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }

  if (data.dificuldade) {
    lines.push(`## Nível de dificuldade`);
    lines.push(String(data.dificuldade));
    lines.push("");
  }

  if (data.observacoes_finais) {
    lines.push(`## Observações finais`);
    lines.push(String(data.observacoes_finais));
    lines.push("");
  }

  return lines.join("\n").trim() || "A IA respondeu, mas não retornou conteúdo formatado.";
}

function detectMode(body = {}) {
  const value = String(
    body.mode ||
    body.action ||
    body.type ||
    body.promptType ||
    body.kind ||
    ""
  ).toLowerCase();

  if (
    value.includes("plan") ||
    value.includes("plano") ||
    value.includes("cronograma") ||
    value.includes("study-plan")
  ) {
    return "plan";
  }

  return "analyze";
}

function buildUserPrompt(body = {}, content = "", mode = "analyze") {
  const subject = body.subject || body.materia || body.materiaNome || "";
  const examDate = body.examDate || body.provaData || body.dataProva || "";
  const availableHours =
    body.availableHours || body.horasPorDia || body.tempoDisponivel || "";
  const customInstruction = body.customPrompt || body.instructions || "";

  if (mode === "plan") {
    return `
Monte um plano de estudo inteligente com base no conteúdo abaixo.

Regras:
- Responda SOMENTE em JSON válido.
- Escreva tudo em português do Brasil.
- Organize a resposta para estudo prático.
- Se existir data de prova, priorize os tópicos mais importantes.
- Se existir matéria, use essa matéria.
- Crie um plano realista.
- Inclua revisões.
- Inclua cronograma por matéria.
- Inclua tarefas claras.

Campos obrigatórios do JSON:
{
  "titulo": "string",
  "resumo": "string",
  "pontos_chave": ["string"],
  "topicos_prioritarios": ["string"],
  "cronograma_por_materia": [
    {
      "materia": "string",
      "objetivo": "string",
      "horas_sugeridas": "string",
      "topicos": ["string"]
    }
  ],
  "plano_de_estudo": [
    {
      "dia": "string",
      "foco": "string",
      "tempo_estimado": "string",
      "tarefas": ["string"]
    }
  ],
  "revisoes": ["string"],
  "questoes_sugeridas": ["string"],
  "dificuldade": "string",
  "observacoes_finais": "string"
}

Dados extras:
- Matéria: ${subject || "não informada"}
- Data da prova: ${examDate || "não informada"}
- Tempo disponível: ${availableHours || "não informado"}
- Instrução extra: ${customInstruction || "nenhuma"}

Conteúdo base:
${content}
    `.trim();
  }

  return `
Analise o conteúdo abaixo para estudo.

Regras:
- Responda SOMENTE em JSON válido.
- Escreva tudo em português do Brasil.
- Faça uma análise clara e útil para quem vai estudar.
- Destaque o que mais importa para prova.
- Sugira revisões e questões.

Campos obrigatórios do JSON:
{
  "titulo": "string",
  "resumo": "string",
  "pontos_chave": ["string"],
  "topicos_prioritarios": ["string"],
  "cronograma_por_materia": [],
  "plano_de_estudo": [],
  "revisoes": ["string"],
  "questoes_sugeridas": ["string"],
  "dificuldade": "string",
  "observacoes_finais": "string"
}

Dados extras:
- Matéria: ${subject || "não informada"}
- Data da prova: ${examDate || "não informada"}
- Instrução extra: ${customInstruction || "nenhuma"}

Conteúdo base:
${content}
  `.trim();
}

async function extractTextFromBuffer(file) {
  const originalName = file.originalname || "arquivo";
  const ext = path.extname(originalName).toLowerCase();
  const buffer = file.buffer;

  if (!buffer || !buffer.length) {
    throw new Error("Arquivo vazio.");
  }

  if (ext === ".pdf") {
    const parsed = await pdfParse(buffer);
    return cleanText(parsed.text);
  }

  if (ext === ".docx" || ext === ".doc") {
    const result = await mammoth.extractRawText({ buffer });
    return cleanText(result.value);
  }

  if (ext === ".xlsx" || ext === ".xls") {
    const workbook = xlsx.read(buffer, { type: "buffer" });
    const parts = [];

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: "" });

      parts.push(`Planilha: ${sheetName}`);
      for (const row of rows) {
        const line = row
          .map((cell) => String(cell ?? "").trim())
          .filter(Boolean)
          .join(" | ");
        if (line) parts.push(line);
      }
      parts.push("");
    }

    return cleanText(parts.join("\n"));
  }

  if (
    [".txt", ".md", ".csv", ".json", ".html", ".htm", ".xml"].includes(ext)
  ) {
    return cleanText(buffer.toString("utf-8"));
  }

  try {
    return cleanText(buffer.toString("utf-8"));
  } catch {
    throw new Error("Formato de arquivo não suportado para extração de texto.");
  }
}

app.get("/api/health", async (_req, res) => {
  return res.json({
    ok: true,
    openai_configured: Boolean(process.env.OPENAI_API_KEY),
    default_model: DEFAULT_MODEL,
    server_time: new Date().toISOString(),
  });
});

app.post("/api/extract-file", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "Nenhum arquivo enviado.",
      });
    }

    const text = await extractTextFromBuffer(req.file);

    return res.json({
      ok: true,
      filename: req.file.originalname,
      text,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Erro ao extrair texto do arquivo.",
    });
  }
});

app.post("/api/study-ai", async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "OPENAI_API_KEY não configurada no servidor.",
      });
    }

    const body = req.body || {};
    const content = cleanText(
      body.content || body.text || body.extractedText || body.material || ""
    );

    if (!content) {
      return res.status(400).json({
        ok: false,
        error: "Nenhum conteúdo foi enviado para análise.",
      });
    }

    const mode = detectMode(body);
    const model = body.model || DEFAULT_MODEL;

    const prompt = buildUserPrompt(body, content, mode);

    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    let rawText = "";

    try {
      const completion = await openai.chat.completions.create({
        model,
        temperature: 0.4,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Você é um especialista em aprendizagem, organização de estudos e preparação para provas. Responda apenas em JSON válido.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      });

      rawText = completion.choices?.[0]?.message?.content || "";
    } catch (firstError) {
      const completion = await openai.chat.completions.create({
        model,
        temperature: 0.4,
        messages: [
          {
            role: "system",
            content:
              "Você é um especialista em aprendizagem, organização de estudos e preparação para provas. Responda apenas em JSON válido.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      });

      rawText = completion.choices?.[0]?.message?.content || "";
    }

    const structured =
      safeJsonParse(rawText) || {
        titulo: mode === "plan" ? "Plano de estudo" : "Análise do conteúdo",
        resumo: rawText || "A IA respondeu sem JSON estruturado.",
        pontos_chave: [],
        topicos_prioritarios: [],
        cronograma_por_materia: [],
        plano_de_estudo: [],
        revisoes: [],
        questoes_sugeridas: [],
        dificuldade: "não definida",
        observacoes_finais: "",
      };

    const result = formatStructuredResult(structured);

    return res.json({
      ok: true,
      mode,
      model,
      result,
      structured,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error:
        error?.message || "Erro interno ao processar a solicitação da IA.",
    });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});
