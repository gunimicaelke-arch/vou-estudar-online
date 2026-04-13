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

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  res.status(200).json({
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

1. Leia todo o conteúdo e separe os tópicos principais.
2. Estude 3 blocos de 25 minutos com 5 minutos de pausa.
3. Faça resumo curto dos pontos mais importantes.
4. Crie 10 perguntas sobre o conteúdo.
5. Revise em 24 horas.
6. Revise novamente em 3 dias.
7. Faça simulado final antes da prova.

Resumo do foco:
${conteudo.slice(0, 1200)}
      `.trim();

      return res.json({
        ok: true,
        plano: planoLocal
      });
    }

    const prompt = `
Você é um tutor de estudos objetivo e didático.
Monte um plano de estudo em português do Brasil.

Matéria: ${materia}
Data da prova: ${provaData || "não informada"}

Conteúdo do aluno:
${conteudo}

Entregue:
1. visão geral do que estudar
2. plano diário
3. tópicos prioritários
4. perguntas de revisão
5. estratégia de memorização
6. versão simples e prática
`;

    const response = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: "Você cria planos de estudo claros, práticos e motivadores."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.7
    });

    const plano = response.choices?.[0]?.message?.content || "Não foi possível gerar o plano.";

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

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
