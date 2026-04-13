import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 10000;

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@vouestudar.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "123456";

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

app.get("/api/health", (req, res) => {
  return res.status(200).json({
    ok: true,
    message: "Servidor funcionando",
    hasOpenAI: !!process.env.OPENAI_API_KEY
  });
});

app.post("/api/login", (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({
        ok: false,
        message: "Informe email e senha."
      });
    }

    if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
      return res.json({
        ok: true,
        user: {
          name: "Aluno",
          email
        }
      });
    }

    return res.status(401).json({
      ok: false,
      message: "Email ou senha inválidos."
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Erro interno no login."
    });
  }
});

app.post("/api/ia/plano", async (req, res) => {
  try {
    const { materia, provaData, conteudo } = req.body || {};

    if (!materia || !conteudo) {
      return res.status(400).json({
        ok: false,
        message: "Envie matéria e conteúdo."
      });
    }

    if (!openai) {
      const planoLocal = `
Plano de estudo gerado localmente

Matéria: ${materia}
Data da prova: ${provaData || "não informada"}

1. Leia o conteúdo inteiro e separe os tópicos principais.
2. Estude em 3 blocos de 25 minutos com 5 minutos de pausa.
3. Faça um resumo curto dos pontos centrais.
4. Crie 10 perguntas de revisão.
5. Revise em 24 horas.
6. Revise novamente em 3 dias.
7. Faça um simulado final antes da prova.

Trecho do conteúdo analisado:
${conteudo.slice(0, 1200)}
      `.trim();

      return res.json({
        ok: true,
        plano: planoLocal
      });
    }

    const prompt = `
Você é um tutor especialista em estudos.
Responda em português do Brasil, de forma prática, didática e organizada.

Monte um plano de estudo com base nestes dados:

Matéria: ${materia}
Data da prova: ${provaData || "não informada"}

Conteúdo:
${conteudo}

Entregue:
1. visão geral
2. tópicos prioritários
3. plano diário
4. perguntas de revisão
5. estratégia de memorização
6. versão simples e objetiva
`;

    const response = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: "Você cria planos de estudo claros, práticos e objetivos."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.7
    });

    const plano =
      response.choices?.[0]?.message?.content ||
      "Não foi possível gerar o plano.";

    return res.json({
      ok: true,
      plano
    });
  } catch (error) {
    console.error("Erro IA:", error);
    return res.status(500).json({
      ok: false,
      message: "Erro ao gerar plano com IA."
    });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
