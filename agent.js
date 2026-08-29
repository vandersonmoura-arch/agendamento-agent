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

  const calendario = [];
  for (let i = 0; i <= 14; i++) {
    const d = new Date(agora.getTime() + i * 86400000);
    const iso = d.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    const nome = d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit' });
    const rotulo = i === 0 ? ' (hoje)' : i === 1 ? ' (amanha)' : '';
    calendario.push(`${iso} = ${nome}${rotulo}`);
  }

  const system = `Voce e o atendente virtual de uma barbearia, atendendo pelo WhatsApp.

HOJE: ${hoje} (${hojeISO})
HORARIO: ${empresa.hora_abertura}h as ${empresa.hora_fechamento}h

CALENDARIO (use estas datas exatas, nunca calcule por conta propria):
${calendario.join('\n')}

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
- Para datas relativas, procure no CALENDARIO acima. Nunca some dias mentalmente.
- Ao falar a data para o cliente, use o dia da semana e a data do CALENDARIO.
- A lista AGENDAMENTOS ATIVOS acima e a UNICA fonte de verdade. Se o historico da conversa menciona um agendamento que nao esta nessa lista, esse agendamento NAO EXISTE e precisa ser criado.
- NUNCA diga que agendou sem ter chamado criar_agendamento e recebido ok nesta mesma resposta.
- Se o cliente ja tem o agendamento na lista acima, NAO crie outro. Apenas confirme o que existe.
- Se o cliente disser que tanto faz o profissional, escolha o primeiro livre e siga sem perguntar.
- Chame criar_agendamento UMA unica vez por agendamento. Nunca repita a chamada.`;

  const messages = [...historico, { role: 'user', content: mensagem }];
  const ctx = { empresa_id, telefone, nome_cliente };

  let resposta = '';
  let entrada = 0, saida = 0;
  let agendouComSucesso = false;
  let ultimoErroFerramenta = null;

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
      if (c.name === 'criar_agendamento') {
        if (out && out.ok) {
          agendouComSucesso = true;
        } else {
          ultimoErroFerramenta = (out && out.erro) || 'desconhecido';
        }
      }
      console.log('[' + telefone + '] tool=' + c.name + ' ok=' + (out && !out.erro) + ' args=' + JSON.stringify(c.input));
      resultados.push({ type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(out) });
    }

    messages.push({ role: 'user', content: resultados });
  }

  if (!resposta) resposta = 'Desculpe, tive um problema aqui. Pode repetir, por favor?';

  // Trava de seguranca: nunca afirmar agendamento que nao foi gravado.
  const afirmaAgendamento = /agendad|agendamento confirmado|marcado para|ta marcado|esta marcado|confirmado!/i.test(resposta);
  if (afirmaAgendamento && !agendouComSucesso) {
    const jaTinha = jaMarcados.length > 0;
    if (!jaTinha) {
      console.error('[' + telefone + '] ALERTA: resposta afirmou agendamento sem gravar. erro=' + ultimoErroFerramenta);
      resposta = ultimoErroFerramenta === 'horario_ocupado'
        ? 'Opa, esse horario acabou de ser preenchido. Me diz outro horario que eu verifico pra voce.'
        : 'Desculpe, nao consegui concluir o agendamento agora. Pode tentar de novo em instantes ou me chamar que um atendente resolve.';
    }
  }

  console.log('[' + telefone + '] tokens in=' + entrada + ' out=' + saida);

  await salvarConversa(empresa_id, telefone, mensagem, resposta);

  return { resposta, acao: 'resposta', agendamento_id: null, tokens: { entrada, saida } };
}
