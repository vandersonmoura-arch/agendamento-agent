import Anthropic from '@anthropic-ai/sdk';
import { salvarConversa, obterHistoricoConversas, obterConfigurEmpresa, obterServicos, obterProfissionais } from './database.js';
import { FERRAMENTAS, executarFerramenta } from './tools.js';
import { listarAgendamentosCliente } from './database.js';
import dotenv from 'dotenv';

dotenv.config();

const client = new Anthropic();
const MODELO = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const MAX_VOLTAS = 5;

export async function processarMensagem({ telefone, mensagem, empresa_id, nome_cliente }) {
  const [historico, empresa, servicos, profissionais, jaMarcados] = await Promise.all([
    obterHistoricoConversas(empresa_id, telefone),
    obterConfigurEmpresa(empresa_id),
    obterServicos(empresa_id),
    obterProfissionais(empresa_id),
    listarAgendamentosCliente(empresa_id, telefone)
  ]);

  const agora = new Date();
  const hoje = agora.toLocaleDateString('pt-BR', {
    timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric'
  });
  const hojeISO = agora.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });

  const system = `Voce e o atendente virtual de uma barbearia, atendendo pelo WhatsApp.

HOJE: ${hoje} (${hojeISO})
HORARIO: ${empresa.hora_abertura}h as ${empresa.hora_fechamento}h

SERVICOS (use o codigo entre parenteses nas ferramentas):
${servicos.map(s => `- ${s.nome} (${s.servico_id}): ${s.preco}, ${s.duracao_minutos} min`).join('\n')}

PROFISSIONAIS (use o codigo entre parenteses):
${profissionais.map(p => `- ${p.nome} (${p.profissional_id})`).join('\n')}

CLIENTE: ${nome_cliente || 'nao informado'}

AGENDAMENTOS ATIVOS DESTE CLIENTE:
${jaMarcados.length ? jaMarcados.map(a => `- id ${a.id}: ${a.servico_nome} em ${a.data} as ${String(a.hora_inicio).slice(0,5)} com ${a.profissional_nome}`).join('\n') : '- nenhum'}

COMO ATENDER:
- Portugues brasileiro, cordial e direto. Mensagens curtas, sem markdown.
- NUNCA invente horarios livres. Sempre chame consultar_disponibilidade antes de oferecer.
- Antes de agendar, tenha os quatro dados: servico, data, horario e profissional.
- Se o cliente nao escolher profissional, ofereca os que estiverem livres.
- Confirme os dados e so entao chame criar_agendamento.
- Depois de agendar, confirme em uma frase: servico, dia, hora, profissional e valor.
- Se uma ferramenta retornar erro, explique com naturalidade e ofereca alternativa.
- Converta datas relativas para YYYY-MM-DD usando a data de hoje.
- Se o cliente ja tem o agendamento acima, NAO crie outro. Apenas confirme o que existe.
- Chame criar_agendamento UMA unica vez por agendamento. Nunca repita a chamada.`;

  const messages = [...historico, { role: 'user', content: mensagem }];
  const ctx = { empresa_id, telefone, nome_cliente };

  let resposta = '';
  let entrada = 0, saida = 0;

  for (let volta = 0; volta < MAX_VOLTAS; volta++) {
    const r = await client.messages.create({
      model: MODELO,
      max_tokens: 1024,
      system,
      tools: FERRAMENTAS,
      messages
    });

    entrada += r.usage.input_tokens;
    saida += r.usage.output_tokens;

    const texto = r.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (texto) resposta = texto;

    if (r.stop_reason !== 'tool_use') break;

    const chamadas = r.content.filter(b => b.type === 'tool_use');
    messages.push({ role: 'assistant', content: r.content });

    const resultados = [];
    for (const c of chamadas) {
      let out;
      try {
        out = await executarFerramenta(c.name, c.input, ctx);
      } catch (e) {
        console.error('Ferramenta ' + c.name + ' falhou:', e.message);
        out = { erro: 'falha_interna' };
      }
      console.log('[' + telefone + '] tool=' + c.name + ' args=' + JSON.stringify(c.input));
      resultados.push({ type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(out) });
    }

    messages.push({ role: 'user', content: resultados });
  }

  if (!resposta) resposta = 'Desculpe, tive um problema aqui. Pode repetir, por favor?';

  console.log('[' + telefone + '] tokens in=' + entrada + ' out=' + saida);

  await salvarConversa(empresa_id, telefone, mensagem, resposta);

  return { resposta, acao: 'resposta', agendamento_id: null };
}
