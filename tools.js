import { calcularDisponibilidade, agendar, listarAgendamentosCliente, cancelarPorId } from './database.js';

export const FERRAMENTAS = [
  {
    name: 'consultar_disponibilidade',
    description: 'Consulta os horarios livres para um servico em uma data. Use SEMPRE antes de oferecer horarios ao cliente. Nunca invente disponibilidade.',
    input_schema: {
      type: 'object',
      properties: {
        data: { type: 'string', description: 'Data no formato YYYY-MM-DD' },
        servico_id: { type: 'string', description: 'Codigo do servico: corte, barba ou combo. Opcional - omita quando o cliente ainda nao escolheu o servico e so quer saber os horarios livres.' }
      },
      required: ['data']
    }
  },
  {
    name: 'criar_agendamento',
    description: 'Registra o agendamento. Use apenas depois de confirmar servico, data, horario e profissional com o cliente.',
    input_schema: {
      type: 'object',
      properties: {
        servico_id: { type: 'string' },
        profissional_id: { type: 'string' },
        data: { type: 'string', description: 'YYYY-MM-DD' },
        hora_inicio: { type: 'string', description: 'HH:MM' }
      },
      required: ['servico_id', 'profissional_id', 'data', 'hora_inicio']
    }
  },
  {
    name: 'listar_meus_agendamentos',
    description: 'Lista os agendamentos futuros deste cliente. Use para cancelamento ou quando ele perguntar o que tem marcado.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'cancelar_agendamento',
    description: 'Cancela um agendamento pelo id. Liste antes e confirme com o cliente qual cancelar.',
    input_schema: {
      type: 'object',
      properties: { agendamento_id: { type: 'string' } },
      required: ['agendamento_id']
    }
  }
];

export async function executarFerramenta(nome, args, ctx) {
  const { empresa_id, telefone, nome_cliente } = ctx;

  switch (nome) {
    case 'consultar_disponibilidade':
      return await calcularDisponibilidade(empresa_id, args.data, args.servico_id);

    case 'criar_agendamento':
      return await agendar(empresa_id, telefone, nome_cliente, args.servico_id,
                           args.profissional_id, args.data, args.hora_inicio);

    case 'listar_meus_agendamentos':
      return { agendamentos: await listarAgendamentosCliente(empresa_id, telefone) };

    case 'cancelar_agendamento':
      return await cancelarPorId(empresa_id, telefone, args.agendamento_id);

    default:
      return { erro: 'ferramenta_desconhecida' };
  }
}
