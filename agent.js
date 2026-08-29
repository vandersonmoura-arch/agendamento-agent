import Anthropic from '@anthropic-ai/sdk';
import { salvarConversa, obterHistoricoConversas, obterConfigurEmpresa, obterServicos, obterProfissionais } from './database.js';
import dotenv from 'dotenv';

dotenv.config();

const client = new Anthropic();

const PROMPT_SISTEMA = `Você é um assistente de agendamento inteligente para uma barbearia.

Suas responsabilidades:
1. Entender a intenção do cliente (agendar, cancelar, confirmação, dúvidas)
2. Manter contexto da conversa (histórico)
3. Ser amigável e profissional
4. Sempre confirmar informações antes de agendar
5. Sugerir horários baseado em disponibilidade
6. Responder em português brasileiro

Formatos de resposta:
- Para agendamento: Sempre pergunte: data preferida, serviço, profissional se tiver preferência
- Para cancelamento: Confirme qual agendamento cancelar
- Para confirmação: Agradeça e reconfirme os detalhes
- Para dúvidas: Responda com informações da barbearia

Nunca:
- Agende sem confirmar todos os dados
- Cancele sem confirmação do cliente
- Invente informações da barbearia (use dados reais do contexto)`;

export async function processarMensagem({ telefone, mensagem, empresa_id, nome_cliente }) {
  try {
    const historico = await obterHistoricoConversas(empresa_id, telefone);
    const empresa = await obterConfigurEmpresa(empresa_id);
    const servicos = await obterServicos(empresa_id);
    const profissionais = await obterProfissionais(empresa_id);

    const contextoEmpresa = `
INFORMAÇÕES DA BARBEARIA:
- Horários: ${empresa.hora_abertura}h até ${empresa.hora_fechamento}h
- Dias fechados: ${empresa.dias_fechados || 'Nenhum'}
- Antecedência mínima: ${empresa.antecedencia_minima_horas || 24}h
- Email: ${empresa.email_dono}

SERVIÇOS DISPONÍVEIS:
${servicos.map(s => `- ${s.nome}: R$ ${s.preco} (${s.duracao_minutos}min)`).join('\n')}

PROFISSIONAIS:
${profissionais.map(p => `- ${p.nome} (${p.ativo ? 'ativo' : 'indisponível'})`).join('\n')}

HISTÓRICO DE CONVERSAS ANTERIORES:
${historico.length > 0 
  ? historico.map(h => `${h.criada_em}: ${h.mensagem_cliente}\n→ ${h.resposta_agente}`).join('\n\n')
  : 'Primeira conversa com este cliente'
}`;

    const mensagens = [
      {
        role: 'user',
        content: `${contextoEmpresa}\n\nNOVA MENSAGEM DO CLIENTE:\n"${mensagem}"\n\nCliente: ${nome_cliente || 'Desconhecido'}\nTelefone: ${telefone}\n\nResponda de forma amigável e profissional. Se for agendar, confirme todos os dados.`
      }
    ];

    console.log(`🤖 Chamando Claude para: ${telefone}`);
    
    const response = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      system: PROMPT_SISTEMA,
      messages: mensagens
    });

    const respostaTexto = response.content[0].text;

    await salvarConversa(empresa_id, telefone, mensagem, respostaTexto);

    let acao = 'resposta';
    if (respostaTexto.toLowerCase().includes('agendad') || respostaTexto.toLowerCase().includes('marqu')) {
      acao = 'agendamento';
    } else if (respostaTexto.toLowerCase().includes('cancelad') || respostaTexto.toLowerCase().includes('desmarc')) {
      acao = 'cancelamento';
    } else if (respostaTexto.toLowerCase().includes('confirm')) {
      acao = 'confirmacao';
    }

    return {
      resposta: respostaTexto,
      acao: acao,
      agendamento_id: null
    };

  } catch (erro) {
    console.error('❌ Erro em processarMensagem:', erro);
    throw erro;
  }
}

export async function analisarIntencao(mensagem) {
  const intencoes = {
    agendar: /agendar|marcar|quero um horário|reagendar|remarcar/i,
    cancelar: /cancelar|desmarcar|não vou poder|desmarque|cancela/i,
    confirmar: /confirma|confirmed|sim|ok|beleza|tudo bem/i,
    servicos: /serviço|preço|quanto custa|valor|tabela|cardápio/i,
    horario: /que horas|horário de funcionamento|abre|fecha|aberto/i
  };

  for (const [intencao, regex] of Object.entries(intencoes)) {
    if (regex.test(mensagem)) {
      return intencao;
    }
  }

  return 'desconhecido';
}
