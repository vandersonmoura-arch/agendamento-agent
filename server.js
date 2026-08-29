import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import { processarMensagem } from './agent.js';
import { inicializarBanco, obterAgendamentos, criarAgendamento, obterDisponibilidade, confirmarAgendamento, cancelarAgendamento, obterHistoricoConversas } from './database.js';
import { inicializarScheduler } from './scheduler.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

await inicializarBanco();
console.log('✅ Banco de dados conectado');

inicializarScheduler();
console.log('✅ Scheduler de lembretes inicializado');

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/processar', async (req, res) => {
  try {
    const { telefone, mensagem, empresa_id, nome_cliente } = req.body;

    if (!telefone || !mensagem || !empresa_id) {
      return res.status(400).json({ erro: 'Faltam campos: telefone, mensagem, empresa_id' });
    }

    console.log(`📱 Processando: ${telefone} - "${mensagem}"`);

    const resposta = await processarMensagem({
      telefone,
      mensagem,
      empresa_id,
      nome_cliente
    });

    console.log(`✅ Resposta gerada: ${resposta.resposta}`);

    res.json({
      ok: true,
      resposta: resposta.resposta,
      acao: resposta.acao,
      agendamento_id: resposta.agendamento_id,
      tokens: resposta.tokens
    });

  } catch (erro) {
    console.error('❌ Erro em /api/processar:', erro);
    res.status(500).json({ erro: 'Erro ao processar mensagem', detalhes: erro.message });
  }
});

app.get('/api/agendamentos/hoje/:empresa_id', async (req, res) => {
  try {
    const { empresa_id } = req.params;
    const agendamentos = await obterAgendamentos(empresa_id, 'hoje');
    res.json(agendamentos);
  } catch (erro) {
    console.error('❌ Erro GET /api/agendamentos/hoje:', erro);
    res.status(500).json({ erro: erro.message });
  }
});

app.get('/api/agendamentos/disponibilidade/:empresa_id', async (req, res) => {
  try {
    const { empresa_id } = req.params;
    const { data, servico_id } = req.query;

    if (!data) {
      return res.status(400).json({ erro: 'Falta parâmetro: data (YYYY-MM-DD)' });
    }

    const disponibilidade = await obterDisponibilidade(empresa_id, data, servico_id);
    res.json(disponibilidade);
  } catch (erro) {
    console.error('❌ Erro GET /api/agendamentos/disponibilidade:', erro);
    res.status(500).json({ erro: erro.message });
  }
});

app.post('/api/agendamentos/criar', async (req, res) => {
  try {
    const {
      empresa_id,
      telefone,
      cliente_nome,
      servico_id,
      profissional_id,
      data,
      hora_inicio,
      hora_fim,
      preco
    } = req.body;

    const agendamento = await criarAgendamento({
      empresa_id,
      telefone,
      cliente_nome,
      servico_id,
      profissional_id,
      data,
      hora_inicio,
      hora_fim,
      preco
    });

    res.status(201).json(agendamento);
  } catch (erro) {
    console.error('❌ Erro POST /api/agendamentos/criar:', erro);
    res.status(500).json({ erro: erro.message });
  }
});

app.put('/api/agendamentos/:id/confirmar', async (req, res) => {
  try {
    const { id } = req.params;
    const resultado = await confirmarAgendamento(id);
    res.json(resultado);
  } catch (erro) {
    console.error('❌ Erro PUT /api/agendamentos/:id/confirmar:', erro);
    res.status(500).json({ erro: erro.message });
  }
});

app.delete('/api/agendamentos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const resultado = await cancelarAgendamento(id);
    res.json(resultado);
  } catch (erro) {
    console.error('❌ Erro DELETE /api/agendamentos/:id:', erro);
    res.status(500).json({ erro: erro.message });
  }
});

app.get('/api/conversas/:telefone/:empresa_id', async (req, res) => {
  try {
    const { telefone, empresa_id } = req.params;
    const historico = await obterHistoricoConversas(empresa_id, telefone);
    res.json(historico);
  } catch (erro) {
    console.error('❌ Erro GET /api/conversas:', erro);
    res.status(500).json({ erro: erro.message });
  }
});

app.use((err, req, res, next) => {
  console.error('❌ Erro não tratado:', err);
  res.status(500).json({ erro: 'Erro interno do servidor', msg: err.message });
});

app.listen(PORT, () => {
  console.log(`\n🚀 Servidor rodando em http://localhost:${PORT}`);
  console.log(`🏥 Health check: http://localhost:${PORT}/health\n`);
});

export default app;
