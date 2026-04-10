# Vou Estudar+ Online

Versão pronta para subir online com **um único link**:
- o HTML abre no `/`
- a IA responde em `/api/study-ai`
- a extração de arquivos usa `/api/extract-file`
- o teste usa `/api/health`

## Arquivos principais
- `server.js`
- `vou-estudar-ia-real.html`
- `package.json`
- `.env.example`
- `render.yaml`

## Deploy mais simples no Render

### 1. Suba esta pasta para um repositório no GitHub
Pode enviar todos os arquivos acima para um repositório novo.

### 2. No Render, crie um Web Service
Conecte o repositório e use:

- **Build Command:** `npm install`
- **Start Command:** `npm start`

### 3. Configure as variáveis de ambiente
No Render, crie estas variáveis:

```env
OPENAI_API_KEY=sua_chave_real
ALLOWED_ORIGIN=*
DEFAULT_MODEL=gpt-4.1-mini
```

## Como funciona depois do deploy
- Seu link principal abre o sistema: `/`
- O endpoint já está pronto no HTML como: `/api/study-ai`
- O botão **Testar conexão** chama: `/api/health`

## Se quiser testar localmente também
```bash
npm install
npm start
```

Depois abra:
- `http://localhost:3000/`
- `http://localhost:3000/api/health`

## Observação importante
A chave da OpenAI fica no servidor. Não coloque a chave no HTML.
