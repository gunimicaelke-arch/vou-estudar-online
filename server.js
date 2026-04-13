import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import multer from "multer";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 10000;

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@vouestudar.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "123456";

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024
  }
});

function limparTexto(texto = "") {
  return String(texto)
    .replace(/\r/g, "")
    .replace(/\t/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

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
    console.error("Erro no login:", error);
    return res.status(500).json({
      ok: false,
      message: "Erro interno no login."
    });
  }
});

app.post("/api/importar-arquivo", upload.single("arquivo"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        message: "Nenhum arquivo enviado."
      });
    }

    const nome = req.file.originalname || "";
    const ext = path.extname(nome).toLowerCase();
    let texto = "";

    if (ext === ".txt" || ext === ".csv") {
      texto = req.file.buffer.toString("utf-8");
    } else if (ext === ".docx") {
      const result = await mammoth.extractRawText({ buffer: req.file.buffer });
      texto = result.value || "";
    } else if (ext === ".pdf") {
      const result = await pdfParse(req.file.buffer);
      texto = result.text || "";
    } else {
      return res.status(400).json({
        ok: false,
        message: "Formato não suportado. Use PDF, CSV, TXT ou DOCX."
      });
    }

    texto = limparTexto(texto);

    if (!texto) {
      return res.status(400).json({
        ok: false,
        message: "Não foi possível extrair conteúdo desse arquivo."
      });
    }

    return res.json({
      ok: true,
      nomeArquivo: nome,
      conteudo: texto
    });
  } catch (error) {
    console.error("Erro ao importar arquivo:", error);
    return res.status(500).json({
      ok: false,
      message: "Erro ao importar arquivo."
    });
  }
});

app.post("/api/inteligente/plano", async (req, res) => {
  try {
    const { materia, provaData, conteudo } = req.body || {};

    if (!materia || !conteudo) {
      return res.status(400).json({
        ok: false,
        message: "Envie matéria e conteúdo."
      });
    }

    const conteudoLimpo = limparTexto(conteudo).slice(0, 12000);

    if (!openai) {
      const planoLocal = `
PLANO DE ESTUDO INTELIGENTE

Matéria: ${materia}
Data da prova: ${provaData || "não informada"}

1. VISÃO GERAL
- Leia todo o conteúdo com atenção.
- Identifique conceitos centrais, definições e pontos que mais caem.
- Marque o que exige memorização e o que exige compreensão.

2. TÓPICOS PRIORITÁRIOS
- Conceitos principais da matéria
- Pontos com maior chance de cobrança
- Dúvidas recorrentes
- Resumos e exemplos práticos

3. PLANO PRÁTICO DE ESTUDO
Dia 1:
- Leitura completa do material
- Separação dos tópicos mais importantes
- Resumo curto por blocos

Dia 2:
- Revisão dos tópicos principais
- Resolução de perguntas próprias
- Releitura dos pontos difíceis

Dia 3:
- Revisão ativa sem olhar o material
- Explicação em voz alta
- Ajuste final do resumo

Dia 4:
- Simulado ou revisão final
- Reforço nos erros
- Fechamento do conteúdo

4. PERGUNTAS DE REVISÃO
- Qual é a definição principal do tema?
- Quais são as classificações mais importantes?
- Quais pontos costumam confundir?
- Como explicar esse conteúdo de forma simples?

5. ESTRATÉGIA DE MEMORIZAÇÃO
- Use blocos curtos de estudo
- Revise em 24 horas
- Revise novamente em 3 dias
- Transforme o conteúdo em perguntas e respostas

6. RESUMO FINAL SIMPLES
- Leia
- Resuma
- Revise
- Teste-se
- Corrija falhas

TRECHO ANALISADO:
${conteudoLimpo.slice(0, 2000)}
      `.trim();

      return res.json({
        ok: true,
        plano: planoLocal
      });
    }

    const prompt = `
Você é um tutor especialista em aprendizagem acadêmica.
Responda em português do Brasil com linguagem clara, prática e objetiva.
Evite enrolação.
Organize muito bem a resposta.

Monte um plano de estudo com base nestes dados:

Matéria: ${materia}
Data da prova: ${provaData || "não informada"}

Conteúdo:
${conteudoLimpo}

Entregue exatamente nesta estrutura:
1. VISÃO GERAL
2. TÓPICOS PRIORITÁRIOS
3. PLANO PRÁTICO DE ESTUDO
4. PERGUNTAS DE REVISÃO
5. ESTRATÉGIA DE MEMORIZAÇÃO
6. RESUMO FINAL SIMPLES

Deixe o plano útil para um acadêmico que quer praticidade no dia a dia.
`;

    const response = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: "Você cria planos de estudo claros, organizados, práticos e fáceis de aplicar."
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
    console.error("Erro no plano inteligente:", error);
    return res.status(500).json({
      ok: false,
      message: "Erro ao gerar plano."
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
