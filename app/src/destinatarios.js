'use strict';

/**
 * app/src/destinatarios.js — davileles/teamrausch
 *
 * Traduz um "público" (todos, wellhub, mensalista, devedores) na lista de
 * alunos que vai receber a mensagem, já com os valores dos marcadores.
 *
 * FICA SEPARADO DAS ROTAS DE PROPÓSITO
 *   A tela monta a lista antes de disparar, e o agendador monta a mesma lista
 *   sozinho na hora do envio programado. Se cada um calculasse do seu jeito,
 *   "todos os ativos" acabaria significando coisas diferentes nos dois lugares
 *   — e a diferença só apareceria quando alguém reclamasse de não ter recebido.
 *
 * SEM TELEFONE NÃO É ERRO, É AVISO
 *   Boa parte da base veio da planilha sem telefone. Esses alunos entram na
 *   contagem e aparecem na tela marcados, em vez de sumirem em silêncio: o
 *   número que falta é informação sua, não um problema para esconder.
 */

const matriculas = require('./matriculas-store');
const alertas = require('./alertas-frequencia');
const frequencia = require('./frequencia');
const telefone = require('./telefone');

/** Primeiro nome, que é como se fala com o aluno no WhatsApp. */
function primeiroNome(nome) {
  return String(nome || '').trim().split(/\s+/)[0] || '';
}

/**
 * Índice matriculaId → situação de frequência, para preencher {{mesRealizado}}
 * e {{mesEsperado}} mesmo quando o público não é "devedores". Avalia todo
 * mundo (`vinculo: null`), porque um mensalista também recebe mensagem.
 */
function indiceDeFrequencia() {
  const mapa = new Map();
  try {
    const painel = alertas.montarPainel({ vinculo: null });
    for (const a of painel.alunos) mapa.set(a.matriculaId, a);
  } catch (e) {
    // Frequência é enfeite aqui: se o cálculo falhar, a mensagem ainda sai —
    // só os marcadores de treino ficam vazios.
    console.log('[destinatarios] frequência indisponível:', e.message);
  }
  return mapa;
}

function ficha(m, freq) {
  const f = freq || null;
  return {
    matriculaId: m.id,
    nome: m.nome,
    primeiroNome: primeiroNome(m.nome),
    telefone: m.telefone || null,
    telefoneFormatado: m.telefone ? telefone.mostrar(telefone.normalizar(m.telefone) || m.telefone) : null,
    temTelefone: Boolean(telefone.normalizar(m.telefone)),
    vinculo: m.vinculo,
    diasSemana: Array.isArray(m.grade) ? m.grade.length : 0,
    aniversario: m.aniversario || null,
    situacao: f ? f.situacao : null,
    realizado: f ? f.realizado : null,
    esperado: f ? f.esperado : null,
    mesRealizado: f && f.mes ? f.mes.realizado : null,
    mesEsperado: f && f.mes ? f.mes.esperado : null,
    ultimoCheckin: f ? f.ultimoCheckin : null,
    motivo: motivoDe(f),
  };
}

/**
 * Uma linha explicando por que a pessoa está na lista. Sem isto o disparo é
 * uma lista de nomes sem contexto, e conferir antes de enviar significaria
 * abrir a aba Frequência em paralelo, aluno por aluno.
 */
const ROTULO = {
  critico: 'crítico', atrasado: 'atrasado', 'em-dia': 'em dia',
  quitado: 'pacote fechado', 'sem-aula': 'sem aula prevista',
  'sem-grade': 'sem grade', experimental: 'experimental',
};

function motivoDe(f) {
  if (!f) return null;
  const partes = [ROTULO[f.situacao] || f.situacao];
  if (f.mes && f.mes.meta) partes.push(`${f.mes.realizado}/${f.mes.esperado} no mês`);
  if (f.ultimoCheckin) {
    partes.push('último em ' + f.ultimoCheckin.split('-').reverse().slice(0, 2).join('/'));
  } else {
    partes.push('sem check-in');
  }
  return partes.join(' · ');
}

/**
 * @param {string} publico  todos | wellhub | mensalista | devedores
 * @param {object} opcoes   { hoje } — só para o gatilho de aniversário
 */
function montar(publico = 'todos', opcoes = {}) {
  const freq = indiceDeFrequencia();
  let lista;

  if (publico === 'devedores') {
    // SÓ WELLHUB, E ISSO NÃO É PREFERÊNCIA — É O LIMITE DO DADO
    //   Check-in só existe pelo portal do Wellhub. O mensalista treina e nada
    //   é registrado, então a conta dele fecha em realizado 0 contra a meta da
    //   grade e ele vira crítico todo mês. Cobrar por isso é acusar quem veio.
    //   Enquanto não houver check-in de mensalista, esta lista é de Wellhub.
    const painel = alertas.montarPainel({ vinculo: 'wellhub' });
    const ids = new Set(frequencia.devedores(painel).map((a) => a.matriculaId));
    lista = matriculas.listar().filter((m) => m.ativo && ids.has(m.id));
  } else {
    lista = matriculas.listar().filter((m) => {
      if (!m.ativo) return false;
      if (publico === 'wellhub') return m.vinculo === 'wellhub';
      if (publico === 'mensalista') return m.vinculo === 'mensalista';
      return true;
    });
  }

  const alunos = lista.map((m) => ficha(m, freq.get(m.id)));

  // Aniversariantes do dia: filtro extra, aplicado sobre qualquer público.
  const filtrados = opcoes.aniversarioEm
    ? alunos.filter((a) => a.aniversario === opcoes.aniversarioEm)
    : alunos;

  return {
    publico,
    total: filtrados.length,
    comTelefone: filtrados.filter((a) => a.temTelefone).length,
    semTelefone: filtrados.filter((a) => !a.temTelefone).length,
    alunos: filtrados.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')),
  };
}

/**
 * Troca os {{marcadores}} pelos valores do aluno. Marcador desconhecido vira
 * string vazia — o mesmo comportamento de `mensageiro.preencher`, para o texto
 * escrito na tela se comportar igual no envio manual e no programado.
 */
function preencher(texto, aluno, extras = {}) {
  const valores = {
    nome: aluno.primeiroNome,
    nomeCompleto: aluno.nome,
    vinculo: aluno.vinculo === 'wellhub' ? 'Wellhub' : 'mensalista',
    diasSemana: aluno.diasSemana,
    realizado: aluno.realizado === null ? '' : aluno.realizado,
    esperado: aluno.esperado === null ? '' : aluno.esperado,
    mesRealizado: aluno.mesRealizado === null ? '' : aluno.mesRealizado,
    mesEsperado: aluno.mesEsperado === null ? '' : aluno.mesEsperado,
    ...extras,
  };
  return String(texto || '').replace(/\{\{(\w+)\}\}/g, (_, chave) =>
    valores[chave] === undefined || valores[chave] === null ? '' : String(valores[chave]));
}

/** Lista dos marcadores, para a tela oferecer os botões de inserir. */
const MARCADORES = [
  { chave: 'nome', descricao: 'Primeiro nome do aluno' },
  { chave: 'nomeCompleto', descricao: 'Nome completo' },
  { chave: 'vinculo', descricao: 'Wellhub ou mensalista' },
  { chave: 'diasSemana', descricao: 'Dias de treino combinados por semana' },
  { chave: 'mesRealizado', descricao: 'Treinos feitos no mês' },
  { chave: 'mesEsperado', descricao: 'Treinos combinados no mês' },
  { chave: 'realizado', descricao: 'Treinos feitos na janela' },
  { chave: 'esperado', descricao: 'Treinos esperados na janela' },
];

module.exports = { montar, preencher, primeiroNome, MARCADORES };
