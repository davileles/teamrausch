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
    // Números do fechamento do mês, que são os que a cobrança usa.
    metaDoMes: f && f.mes ? f.mes.meta : null,
    faltamNoMes: f && f.mes ? f.mes.faltam : null,
    atrasoNoRitmo: f && f.mes ? f.mes.atrasoNoRitmo : null,
    diasRestantes: f && f.mes ? f.mes.diasRestantes : null,
    diasSemTreinar: f ? f.diasSemTreinar : null,
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
function dataCurta(iso) {
  return iso ? iso.split('-').reverse().slice(0, 2).join('/') : '';
}

function preencher(texto, aluno, extras = {}) {
  const valores = {
    /* --- nomes atuais, os que a tela oferece --- */
    nome: aluno.primeiroNome,
    nomeCompleto: aluno.nome,
    treinosNoMes: aluno.mesRealizado,
    metaDoMes: aluno.metaDoMes,
    treinosQueFaltam: aluno.faltamNoMes,
    treinosAtrasados: aluno.atrasoNoRitmo,
    treinosPorSemana: aluno.diasSemana,
    diasSemTreinar: aluno.diasSemTreinar,
    ultimoTreino: dataCurta(aluno.ultimoCheckin),
    diasAteFimDoMes: aluno.diasRestantes,
    plano: aluno.vinculo === 'wellhub' ? 'Wellhub' : 'mensalista',

    /* --- NOMES ANTIGOS, MANTIDOS DE PROPÓSITO ---
       Modelos escritos antes desta troca continuam no ar. Tirar estas chaves
       faria a mensagem sair com um buraco no lugar do número, e o aluno é que
       receberia o texto quebrado. Não aparecem mais na lista da tela. */
    vinculo: aluno.vinculo === 'wellhub' ? 'Wellhub' : 'mensalista',
    diasSemana: aluno.diasSemana,
    realizado: aluno.realizado,
    esperado: aluno.esperado,
    mesRealizado: aluno.mesRealizado,
    mesEsperado: aluno.mesEsperado,

    ...extras,
  };
  return String(texto || '').replace(/\{\{(\w+)\}\}/g, (_, chave) =>
    valores[chave] === undefined || valores[chave] === null ? '' : String(valores[chave]));
}

/** Lista dos marcadores, para a tela oferecer os botões de inserir. */
/**
 * O que a tela oferece. A descrição é o texto que o marcador substitui, não o
 * nome técnico do campo: quem escreve a mensagem precisa saber o que vai
 * aparecer para o aluno, e `mesEsperado` não dizia isso a ninguém.
 */
const MARCADORES = [
  { chave: 'nome', descricao: 'Primeiro nome — "Ana"', exemplo: 'Ana' },
  { chave: 'nomeCompleto', descricao: 'Nome completo — "Ana Souza"', exemplo: 'Ana Souza' },
  { chave: 'treinosNoMes', descricao: 'Quantos treinos já fez este mês', exemplo: '4' },
  { chave: 'metaDoMes', descricao: 'Quantos treinos o pacote dele prevê no mês', exemplo: '12' },
  { chave: 'treinosQueFaltam', descricao: 'Quantos ainda faltam para fechar o mês', exemplo: '8' },
  { chave: 'treinosAtrasados', descricao: 'Quantos está atrás do ritmo combinado', exemplo: '2' },
  { chave: 'treinosPorSemana', descricao: 'Quantas vezes por semana ele combinou treinar', exemplo: '3' },
  { chave: 'diasSemTreinar', descricao: 'Há quantos dias não aparece', exemplo: '9' },
  { chave: 'ultimoTreino', descricao: 'Data do último treino — "18/08"', exemplo: '18/08' },
  { chave: 'diasAteFimDoMes', descricao: 'Quantos dias ainda restam no mês', exemplo: '11' },
  { chave: 'plano', descricao: 'Wellhub ou mensalista', exemplo: 'Wellhub' },
];

module.exports = { montar, preencher, primeiroNome, MARCADORES };
