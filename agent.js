import Anthropic from '@anthropic-ai/sdk';
import { salvarConversa, obterHistoricoConversas, obterConfigurEmpresa, obterServicos, obterProfissionais } from './database.js';
import dotenv from 'dotenv';

dotenv.config();

const client = new Anthropic();
const MODELO = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

export async function processarMensagem({ telefone, mensagem, empresa_id, nome_cliente }) {
  const [historico, empresa, servicos, profissionais] = await Promise.all([
    obterHistoricoConversas(empresa_id, telefone),
    obterConfigurEmpresa(empresa_id),
    obterServicos(empresa_id),
    obterProfissionais(empresa_id)
  ]);

  const hoje = new Date().toLocaleDateString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric'
  });

  const system = `Voce e o atendente virtual de uma barbearia. Atende clientes pelo WhatsApp.

DATA DE HOJE: ${hoje}

HORARIOS: das ${empresa.hora_abertura}h as ${empresa.hora_fechamento}h
ANTECEDENCIA MINIMA: ${empresa.antecedencia_minima_horas || 24}h

SERVICOS:
${servicos.length ? servicos.map(s => `- ${s.nome}: R$ ${s.preco} (${s.duracao_minutos} min)`).join('\n') : '- Nenhum servico cadastrado'}

PROFISSIONAIS:
${profissionais.length ? profissionais.map(p => `- ${p.nome}`).join('\n') : '- Nenhum profissional cadastrado'}

CLIENTE: ${nome_cliente || 'nao informado'} (${telefone})

REGRAS:
- Responda em portugues brasileiro, tom cordial e direto.
- Mensagens curtas, adequadas ao WhatsApp. Sem markdown.
- Use APENAS os servicos, precos e profissionais listados acima. Nunca invente.
- Se nao houver servicos cadastrados, diga que vai verificar e peca um momento.
- Para agendar, colete: servico, data, horario e profissional (se houver preferencia).
- Confirme todos os dados antes de fechar o agendamento.
- Considere o que ja foi dito antes nesta conversa. Nao repita perguntas ja respondidas.`;

  const messages = [...historico, { role: 'user', content: mensagem }];

  const response = await client.messages.create({
    model: MODELO,
    max_tokens: 1024,
    system,
    messages
  });

  const texto = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();

  console.log(`[${telefone}] in=${response.usage.input_tokens} out=${response.usage.output_tokens}`);

  await salvarConversa(empresa_id, telefone, mensagem, texto);

  return { resposta: texto, acao: 'resposta', agendamento_id: null };
}
