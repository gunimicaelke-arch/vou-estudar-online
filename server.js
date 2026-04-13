import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.post("/api/ai-study-plan", async (req, res) => {
  try {
    const { subjectName, content, examDate, hoursPerDay } = req.body || {};

    if (!subjectName || !content || !examDate || !hoursPerDay) {
      return res.status(400).json({
        error: "Dados incompletos para gerar o plano."
      });
    }

    const prompt = `
Você é um tutor especialista em estudo para provas.
Crie um plano de estudo prático, organizado e inteligente.

Matéria: ${subjectName}
Data da prova: ${examDate}
Horas por dia disponíveis: ${hoursPerDay}
Conteúdo:
${content}

Quero que o plano:
1. Divida o estudo em etapas.
2. Mostre prioridade do que estudar primeiro.
3. Separe revisão, leitura, questões e memorização.
4. Organize por dias até a data da prova.
5. Use português do Brasil.
6. Seja objetivo, claro e motivador.
7. Traga uma estratégia de estudo inteligente baseada no conteúdo.
`;

    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: prompt
    });

    const plan = response.output_text?.trim() || "Plano não gerado.";

    return res.json({ plan });
  } catch (error) {
    console.error("Erro IA:", error);
    return res.status(500).json({
      error: "Erro ao gerar plano com IA."
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
