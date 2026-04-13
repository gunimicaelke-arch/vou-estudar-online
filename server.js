import express from 'express'
import fetch from 'node-fetch'
import cors from 'cors'

const app = express()
app.use(cors())
app.use(express.json())

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

app.listen(3000,()=>console.log("rodando"))
