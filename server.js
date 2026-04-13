import express from 'express'
import fetch from 'node-fetch'
import cors from 'cors'

const app = express()
app.use(cors())
app.use(express.json())

// ✅ ROTA OBRIGATÓRIA PARA O RENDER
app.get('/api/health', (req, res) => {
  res.status(200).send("OK")
})

// IA
app.post('/api/ia', async (req,res)=>{

try{

const response = await fetch('https://api.openai.com/v1/chat/completions',{
method:'POST',
headers:{
'Content-Type':'application/json',
'Authorization':'Bearer ' + process.env.OPENAI_API_KEY
},
body: JSON.stringify({
model:'gpt-4o-mini',
messages:[
{role:'user', content:req.body.texto}
]
})
})

const data = await response.json()

res.json({resposta: data.choices[0].message.content})

}catch(e){
res.json({resposta:"Erro IA"})
}

})

// 🔥 IMPORTANTE: usar PORT do Render
const PORT = process.env.PORT || 3000
app.listen(PORT, ()=> console.log("rodando na porta " + PORT))
