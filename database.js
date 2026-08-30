import pkg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pkg;

const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'barbearia',
  user: process.env.DB_USER || 'barbearia',
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

pool.on('error', (err) => {
  console.error('❌ Erro na pool do Postgres:', err);
});

export async function inicializarBanco() {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    console.log('✅ Banco de dados conectado:', result.rows[0].now);
    client.release();
    return true;
  } catch (erro) {
    console.error('❌ Erro ao conectar ao banco:', erro);
    throw erro;
  }
}

export async function salvarConversa(empresa_id, telefone, mensagem_cliente, resposta_agente) {
  try {
    const novas = JSON.stringify([
      { papel: 'user', texto: mensagem_cliente, em: new Date().toISOString() },
      { papel: 'assistant', texto: resposta_agente, em: new Date().toISOString() }
    ]);

    const query = `
      INSERT INTO conversas (empresa_id, telefone, estado, status)
      VALUES ($1, $2, jsonb_build_object('mensagens', $3::jsonb), 'ativo')
      ON CONFLICT (empresa_id, telefone) DO UPDATE
      SET estado = jsonb_set(
            COALESCE(conversas.estado, '{}'::jsonb),
            '{mensagens}',
            (
              SELECT COALESCE(jsonb_agg(elem ORDER BY ord), '[]'::jsonb)
              FROM (
                SELECT elem, ord
                FROM jsonb_array_elements(
                  COALESCE(conversas.estado->'mensagens', '[]'::jsonb) || $3::jsonb
                ) WITH ORDINALITY AS t(elem, ord)
                ORDER BY ord DESC
                LIMIT 20
              ) s
            )
          ),
          atualizado_em = NOW()
      RETURNING id;
    `;

    const result = await pool.query(query, [empresa_id, telefone, novas]);
    return result.rows[0];
  } catch (erro) {
    console.error('Erro ao salvar conversa:', erro.message);
    throw erro;
  }
}

export async function obterHistoricoConversas(empresa_id, telefone) {
  try {
    const result = await pool.query(
      `SELECT estado FROM conversas WHERE empresa_id = $1 AND telefone = $2 LIMIT 1;`,
      [empresa_id, telefone]
    );

    if (result.rows.length === 0) return [];

    const mensagens = result.rows[0].estado?.mensagens || [];
    return mensagens.map(m => ({
      role: m.papel === 'user' ? 'user' : 'assistant',
      content: m.texto
    }));
  } catch (erro) {
    console.error('Erro ao obter historico:', erro.message);
    return [];
  }
}

export async function obterConfigurEmpresa(empresa_id) {
  try {
    const query = `SELECT * FROM configuracoes_empresa WHERE empresa_id = $1;`;
    const result = await pool.query(query, [empresa_id]);
    if (result.rows.length === 0) {
      return {
        hora_abertura: 9,
        hora_fechamento: 19,
        dias_fechados: [],
        antecedencia_minima_horas: 24,
        email_dono: 'contato@barbearia.com'
      };
    }
    return result.rows[0];
  } catch (erro) {
    console.error('❌ Erro ao obter configurações:', erro);
    return {};
  }
}

export async function obterServicos(empresa_id) {
  try {
    const query = `SELECT * FROM servicos WHERE empresa_id = $1 AND ativo = true ORDER BY nome;`;
    const result = await pool.query(query, [empresa_id]);
    return result.rows;
  } catch (erro) {
    console.error('❌ Erro ao obter serviços:', erro);
    return [];
  }
}

export async function obterProfissionais(empresa_id) {
  try {
    const query = `SELECT * FROM profissionais WHERE empresa_id = $1 AND ativo = true ORDER BY nome;`;
    const result = await pool.query(query, [empresa_id]);
    return result.rows;
  } catch (erro) {
    console.error('❌ Erro ao obter profissionais:', erro);
    return [];
  }
}

export async function obterAgendamentos(empresa_id, filtro = 'todos') {
  try {
    let query = `SELECT * FROM agendamentos WHERE empresa_id = $1`;
    const params = [empresa_id];

    if (filtro === 'hoje') {
      query += ` AND data = CURRENT_DATE`;
    } else if (filtro === 'confirmados') {
      query += ` AND status = 'confirmado'`;
    }

    query += ` ORDER BY data, hora_inicio;`;
    const result = await pool.query(query, params);
    return result.rows;
  } catch (erro) {
    console.error('❌ Erro ao obter agendamentos:', erro);
    return [];
  }
}

export async function obterDisponibilidade(empresa_id, data, servico_id = null) {
  try {
    const horariosDisponiveis = [];
    const empresa = await obterConfigurEmpresa(empresa_id);
    const abertura = empresa.hora_abertura || 9;
    const fechamento = empresa.hora_fechamento || 19;

    for (let h = abertura; h < fechamento; h++) {
      for (let m = 0; m < 60; m += 30) {
        horariosDisponiveis.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
      }
    }

    const query = `
      SELECT hora_inicio FROM agendamentos 
      WHERE empresa_id = $1 AND data = $2 AND status != 'cancelado'
    `;

    const result = await pool.query(query, [empresa_id, data]);
    const agendados = result.rows.map(r => r.hora_inicio);

    const disponíveis = horariosDisponiveis.filter(h => !agendados.includes(h));

    return {
      data: data,
      horarios_disponiveis: disponíveis,
      total_disponivel: disponíveis.length
    };
  } catch (erro) {
    console.error('❌ Erro ao obter disponibilidade:', erro);
    return { horarios_disponiveis: [] };
  }
}

export async function criarAgendamento({
  empresa_id,
  telefone,
  cliente_nome,
  servico_id,
  profissional_id,
  data,
  hora_inicio,
  hora_fim,
  preco
}) {
  try {
    const query = `
      INSERT INTO agendamentos (
        id, empresa_id, telefone, cliente_nome, servico_id, 
        profissional_id, data, hora_inicio, hora_fim, preco, status, criada_em
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, 'pendente', NOW()
      ) RETURNING *;
    `;

    const result = await pool.query(query, [
      empresa_id,
      telefone,
      cliente_nome,
      servico_id,
      profissional_id,
      data,
      hora_inicio,
      hora_fim,
      preco
    ]);

    return result.rows[0];
  } catch (erro) {
    console.error('❌ Erro ao criar agendamento:', erro);
    throw erro;
  }
}

export async function confirmarAgendamento(agendamento_id) {
  try {
    const query = `
      UPDATE agendamentos 
      SET status = 'confirmado', atualizado_em = NOW()
      WHERE id = $1
      RETURNING *;
    `;

    const result = await pool.query(query, [agendamento_id]);
    return result.rows[0];
  } catch (erro) {
    console.error('❌ Erro ao confirmar agendamento:', erro);
    throw erro;
  }
}

export async function cancelarAgendamento(agendamento_id) {
  try {
    const query = `
      UPDATE agendamentos 
      SET status = 'cancelado', cancelado_em = NOW(), atualizado_em = NOW()
      WHERE id = $1
      RETURNING *;
    `;

    const result = await pool.query(query, [agendamento_id]);
    return result.rows[0];
  } catch (erro) {
    console.error('❌ Erro ao cancelar agendamento:', erro);
    throw erro;
  }
}

export async function obterAgendamentoPorId(agendamento_id) {
  try {
    const query = `SELECT * FROM agendamentos WHERE id = $1;`;
    const result = await pool.query(query, [agendamento_id]);
    return result.rows[0];
  } catch (erro) {
    console.error('❌ Erro ao obter agendamento:', erro);
    return null;
  }
}

// ===== AGENDA =====

export async function obterServicoPorCodigo(empresa_id, servico_id) {
  const r = await pool.query(
    `SELECT * FROM servicos WHERE empresa_id = $1 AND servico_id = $2 AND ativo = true LIMIT 1;`,
    [empresa_id, servico_id]
  );
  return r.rows[0] || null;
}

function hhmm(t) {
  return String(t).slice(0, 5);
}

function somaMinutos(hora, minutos) {
  const [h, m] = hora.split(':').map(Number);
  const total = h * 60 + m + minutos;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export async function calcularDisponibilidade(empresa_id, data, servico_id) {
  let servico = null;
  let consultaGeral = false;

  if (servico_id) {
    servico = await obterServicoPorCodigo(empresa_id, servico_id);
    if (!servico) return { erro: 'servico_nao_encontrado' };
  } else {
    const todos = await obterServicos(empresa_id);
    if (!todos.length) return { erro: 'sem_servicos' };
    servico = todos.reduce((a, b) => a.duracao_minutos <= b.duracao_minutos ? a : b);
    consultaGeral = true;
  }

  const empresa = await obterConfigurEmpresa(empresa_id);
  const profissionais = await obterProfissionais(empresa_id);
  if (!profissionais.length) return { erro: 'sem_profissionais' };

  const abertura = empresa.hora_abertura ?? 9;
  const fechamento = empresa.hora_fechamento ?? 19;
  const duracao = servico.duracao_minutos;

  const diaSemana = new Date(`${data}T12:00:00`).getDay();
  const fechados = empresa.dias_fechados || [];
  if (fechados.map(Number).includes(diaSemana)) {
    return { data, fechado: true, horarios: [] };
  }

  const ocupados = await pool.query(
    `SELECT profissional_id, hora_inicio, hora_fim FROM agendamentos
     WHERE empresa_id = $1 AND data = $2 AND status IN ('pendente','confirmado');`,
    [empresa_id, data]
  );

  const agora = new Date();
  const minimoHoras = empresa.antecedencia_minima_horas ?? 0;
  const limite = new Date(agora.getTime() + minimoHoras * 3600000);

  const horarios = [];
  for (let h = abertura; h < fechamento; h++) {
    for (const m of [0, 30]) {
      const inicio = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      const fim = somaMinutos(inicio, duracao);
      if (fim > `${String(fechamento).padStart(2, '0')}:00`) continue;
      if (new Date(`${data}T${inicio}:00`) < limite) continue;

      const livres = profissionais.filter(p => {
        return !ocupados.rows.some(o =>
          o.profissional_id === p.profissional_id &&
          inicio < hhmm(o.hora_fim) &&
          fim > hhmm(o.hora_inicio)
        );
      });

      if (livres.length) {
        horarios.push({
          hora: inicio,
          profissionais: livres.map(p => ({ id: p.profissional_id, nome: p.nome }))
        });
      }
    }
  }

  return {
    data,
    servico: consultaGeral ? null : servico.nome,
    consulta_geral: consultaGeral,
    duracao_considerada: duracao,
    horarios
  };
}

export async function agendar(empresa_id, telefone, cliente_nome, servico_id, profissional_id, data, hora_inicio) {
  const servico = await obterServicoPorCodigo(empresa_id, servico_id);
  if (!servico) return { erro: 'servico_nao_encontrado' };

  const prof = await pool.query(
    `SELECT * FROM profissionais WHERE empresa_id = $1 AND profissional_id = $2 AND ativo = true LIMIT 1;`,
    [empresa_id, profissional_id]
  );
  if (!prof.rows.length) return { erro: 'profissional_nao_encontrado' };

  const inicio = hhmm(hora_inicio);
  const fim = somaMinutos(inicio, servico.duracao_minutos);

  const conflito = await pool.query(
    `SELECT 1 FROM agendamentos
     WHERE empresa_id = $1 AND profissional_id = $2 AND data = $3
       AND status IN ('pendente','confirmado')
       AND $4 < hora_fim AND $5 > hora_inicio LIMIT 1;`,
    [empresa_id, profissional_id, data, inicio, fim]
  );
  if (conflito.rows.length) return { erro: 'horario_ocupado' };

  const r = await pool.query(
    `INSERT INTO agendamentos
      (id, empresa_id, telefone, cliente_nome, servico_id, servico_nome,
       profissional_id, profissional_nome, data, hora_inicio, hora_fim, preco, status, criada_em)
     VALUES (gen_random_uuid(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'confirmado',NOW())
     RETURNING id, data, hora_inicio, hora_fim, servico_nome, profissional_nome, preco;`,
    [empresa_id, telefone, cliente_nome, servico_id, servico.nome,
     profissional_id, prof.rows[0].nome, data, inicio, fim, servico.preco]
  );

  return { ok: true, agendamento: r.rows[0] };
}

export async function listarAgendamentosCliente(empresa_id, telefone) {
  const r = await pool.query(
    `SELECT id, data, hora_inicio, servico_nome, profissional_nome, status
     FROM agendamentos
     WHERE empresa_id = $1 AND telefone = $2 AND status IN ('pendente','confirmado')
       AND data >= CURRENT_DATE
     ORDER BY data, hora_inicio;`,
    [empresa_id, telefone]
  );
  return r.rows;
}

export async function cancelarPorId(empresa_id, telefone, agendamento_id) {
  const r = await pool.query(
    `UPDATE agendamentos SET status='cancelado', cancelado_em=NOW(), atualizado_em=NOW()
     WHERE id=$1 AND empresa_id=$2 AND telefone=$3 AND status IN ('pendente','confirmado')
     RETURNING id, data, hora_inicio, servico_nome;`,
    [agendamento_id, empresa_id, telefone]
  );
  return r.rows.length ? { ok: true, cancelado: r.rows[0] } : { erro: 'nao_encontrado' };
}

// ===== LEMBRETES =====

export async function reservarLembretes(tipo) {
  const coluna = tipo === '24h' ? 'lembrete_24h_em' : 'lembrete_2h_em';
  const minimo = tipo === '24h' ? '23 hours' : '90 minutes';
  const maximo = tipo === '24h' ? '25 hours' : '150 minutes';

  const r = await pool.query(`
    UPDATE agendamentos SET ${coluna} = NOW()
    WHERE id IN (
      SELECT a.id FROM agendamentos a
      WHERE a.status = 'confirmado'
        AND a.${coluna} IS NULL
        AND (a.data + a.hora_inicio)
            BETWEEN (NOW() AT TIME ZONE 'America/Sao_Paulo') + INTERVAL '${minimo}'
                AND (NOW() AT TIME ZONE 'America/Sao_Paulo') + INTERVAL '${maximo}'
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, empresa_id, telefone, cliente_nome, servico_nome,
              profissional_nome, data, hora_inicio;
  `);

  return r.rows;
}

export async function obterEvolutionDaEmpresa(empresa_id) {
  const r = await pool.query(
    `SELECT c.evolution_base_url, e.instancia_evolution
     FROM configuracoes_empresa c
     JOIN empresas e ON e.id = c.empresa_id
     WHERE c.empresa_id = $1 LIMIT 1;`,
    [empresa_id]
  );
  return r.rows[0] || null;
}
