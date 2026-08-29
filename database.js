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
