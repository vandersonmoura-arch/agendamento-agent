import cron from 'node-cron';
import { obterAgendamentos, obterAgendamentoPorId } from './database.js';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

export function inicializarScheduler() {
  cron.schedule('*/30 * * * *', async () => {
    console.log(`⏰ Verificando lembretes em ${new Date().toLocaleTimeString()}`);
    await verificarLembretes();
  });
  console.log('✅ Scheduler de lembretes inicializado');
}

async function verificarLembretes() {
  try {
    const agora = new Date();
    const amanha = new Date(agora.getTime() + 24 * 60 * 60 * 1000);
    const daqui2h = new Date(agora.getTime() + 2 * 60 * 60 * 1000);

    await enviarLembrete('24h', amanha);
    await enviarLembrete('2h', daqui2h);

  } catch (erro) {
    console.error('❌ Erro no scheduler:', erro);
  }
}

async function enviarLembrete(tipo, dataBuscaAlvo) {
  try {
    const agendamentos = await obterAgendamentos(null, 'todos');

    for (const agendamento of agendamentos) {
      if (agendamento.status !== 'confirmado') continue;

      const dataAgendamento = new Date(agendamento.data);
      const horaAgendamento = agendamento.hora_inicio.split(':');
      dataAgendamento.setHours(parseInt(horaAgendamento[0]), parseInt(horaAgendamento[1]));

      let enviar = false;

      if (tipo === '24h') {
        const diferenca = Math.abs(dataAgendamento - dataBuscaAlvo) / (1000 * 60 * 60);
        if (diferenca >= 23 && diferenca <= 25) {
          enviar = true;
        }
      } else if (tipo === '2h') {
        const diferenca = Math.abs(dataAgendamento - dataBuscaAlvo) / (1000 * 60);
        if (diferenca >= 100 && diferenca <= 140) {
          enviar = true;
        }
      }

      if (enviar) {
        await enviarViaMensagem(agendamento, tipo);
      }
    }
  } catch (erro) {
    console.error(`❌ Erro ao enviar lembrete ${tipo}:`, erro);
  }
}

async function enviarViaMensagem(agendamento, tipo) {
  try {
    let mensagem = '';

    if (tipo === '24h') {
      mensagem = `Olá ${agendamento.cliente_nome || 'cliente'}! 👋\n\nLembrete: Você tem agendamento amanhã às ${agendamento.hora_inicio} para ${agendamento.servico_nome}.\n\nPorfavor, confirme respondendo com "CONFIRMO"`;
    } else if (tipo === '2h') {
      mensagem = `⏰ Seu agendamento é em 2 HORAS!\n\n${agendamento.servico_nome} às ${agendamento.hora_inicio}\n\nTá vindo? Responda CONFIRMO ou CANCELO`;
    }

    if (process.env.EVOLUTION_BASE_URL && process.env.EVOLUTION_API_KEY) {
      await axios.post(`${process.env.EVOLUTION_BASE_URL}/message/sendText`, {
        number: agendamento.telefone,
        text: mensagem,
        delay: 1000
      }, {
        headers: {
          'apikey': process.env.EVOLUTION_API_KEY,
          'Content-Type': 'application/json'
        }
      });

      console.log(`✅ Lembrete ${tipo} enviado para ${agendamento.telefone}`);
    } else {
      console.log(`📌 Lembrete ${tipo} para ${agendamento.telefone}: ${mensagem}`);
    }

  } catch (erro) {
    console.error('❌ Erro ao enviar mensagem:', erro.message);
  }
}

export async function enviarLembreteManual(agendamento_id, tipo_mensagem = 'padrao') {
  try {
    const agendamento = await obterAgendamentoPorId(agendamento_id);

    if (!agendamento) {
      throw new Error('Agendamento não encontrado');
    }

    let mensagem = `Olá ${agendamento.cliente_nome}! Seu agendamento está confirmado para ${agendamento.data} às ${agendamento.hora_inicio}.`;

    await axios.post(`${process.env.EVOLUTION_BASE_URL}/message/sendText`, {
      number: agendamento.telefone,
      text: mensagem
    }, {
      headers: {
        'apikey': process.env.EVOLUTION_API_KEY
      }
    });

    return { ok: true, enviado: true };
  } catch (erro) {
    console.error('❌ Erro ao enviar lembrete manual:', erro);
    throw erro;
  }
}
