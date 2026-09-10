'use strict';

/**
 * app/src/presencas.js — davileles/teamrausch
 *
 * Duas perguntas diferentes moram aqui, e cada uma tem a sua fonte.
 *
 * 1. COBRANÇA — "este aluno está gerando o que deveria?"
 *    Só o check-in do Wellhub. O repasse vem por check-in validado no portal:
 *    aluno Wellhub que não faz check-in é aula que o estúdio não recebe. O
 *    mensalista já pagou, venha ou não — não há o que cobrar dele.
 *
 *    Frequência, aviso diário, os públicos "Devendo treino" e "Sumidos", o
 *    botão Cobrar e a ficha do aluno leem `mapaPorMatricula` /
 *    `datasDaMatricula`, que devolvem só check-in. A presença do totem NÃO
 *    entra nessa conta, nem para o Wellhub: somá-la faria o aluno que veio e
 *    esqueceu o check-in parecer em dia — justamente o caso em que o dinheiro
 *    se perde.
 *
 * 2. GESTÃO — "quem veio, em que horário, e com liberação?"
 *    O tablet da entrada. Serve para acompanhar a turma e ensinar a vir no
 *    horário certo. Ausência não gera cobrança, e trocar para outra aula no
 *    mesmo dia é livre. Aparece na Lista do dia por `doDia`, com um cruzamento
 *    que interessa ao caixa: aluno Wellhub que confirmou no totem e não tem
 *    check-in naquele dia.
 *
 * A CHAVE QUE SAIU
 *   Existia `frequencia.confirmacaoAtiva` ("Contar a presença do totem"), que
 *   somava as duas fontes. Ligada, ela punha o mensalista na cobrança e
 *   escondia o check-in esquecido do Wellhub — o contrário do que o estúdio
 *   precisa. Foi removida; configs antigas que ainda a tenham gravada são
 *   limpas na leitura (`config.js`) e nada mais a consulta.
 */

const checkins = require('./checkins-store');
const agendaStore = require('./agenda-store');
const matriculas = require('./matriculas-store');
const config = require('./config');

/* ------------------------------ cobrança --------------------------------- */

/**
 * Datas com check-in do Wellhub, por matrícula. Mesma assinatura de
 * `checkins.mapaPorMatricula` — os quatro lugares que cobram continuam
 * chamando por aqui, e é aqui que se decide que a fonte é uma só.
 */
function mapaPorMatricula(janela = {}) {
  return checkins.mapaPorMatricula(janela);
}

/** Datas com check-in de um aluno só. */
function datasDaMatricula(matriculaId) {
  return checkins.datasDaMatricula(matriculaId) || [];
}

/**
 * Quem pode ser cobrado por frequência: só Wellhub. Não é limite de dado —
 * é regra de negócio. Mensalidade paga não depende de aparecer.
 */
function vinculosComDado() {
  return ['wellhub'];
}

/** `frequencia.painel` aceita um vínculo só. */
function vinculoParaPainel() {
  return 'wellhub';
}

function situacao() {
  return {
    cobranca: { fonte: 'checkin-wellhub', vinculos: vinculosComDado() },
    totem: { uso: 'gestao', contaNaCobranca: false },
  };
}

/* ------------------------------- gestão ---------------------------------- */

function finalDoTelefone(t) {
  const d = String(t || '').replace(/\D/g, '');
  return d.length >= 8 ? d.slice(-8) : null;
}

/** Hora local (HH:MM) de um ISO, no fuso do estúdio. */
function horaLocal(iso, fuso) {
  if (!iso) return null;
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: fuso, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso));
  } catch (e) { return null; }
}

/** Nome de quem liberou, pelo telefone do administrador. */
function nomeDoAdmin(telefone) {
  if (!telefone) return null;
  const direto = agendaStore.aluno(telefone);
  if (direto && direto.nome) return direto.nome;
  const alvo = finalDoTelefone(telefone);
  const achado = agendaStore.listarAlunos().find((a) => finalDoTelefone(a.telefone) === alvo);
  return (achado && achado.nome) || null;
}

/**
 * Presenças de um dia, prontas para a Lista do dia.
 *
 * @returns {{
 *   registros: object[],               // uma linha por confirmação no totem
 *   porFinal: Map<string, object[]>,    // 8 últimos dígitos → registros do dia
 *   semCheckinWellhub: Set<string>,     // finais de quem é Wellhub, veio e não tem check-in
 * }}
 */
function doDia(data) {
  const fuso = config.ler().estudio.fuso;
  const fichas = new Map();
  const fichaDe = (tel) => {
    if (!fichas.has(tel)) fichas.set(tel, matriculas.porTelefone(tel) || null);
    return fichas.get(tel);
  };

  const registros = agendaStore.presencasDaData(data).map((p) => {
    const m = fichaDe(p.telefone);
    return {
      telefone: p.telefone,
      final: finalDoTelefone(p.telefone),
      nome: (m && m.nome) || p.nome || null,
      hora: p.hora,
      chegada: horaLocal(p.criadoEm, fuso),
      liberado: p.origem === 'totem-liberado',
      liberadoPor: p.liberadoPor ? (nomeDoAdmin(p.liberadoPor) || null) : null,
      matriculaId: m ? m.id : null,
      contaId: m ? (m.contaDe || m.id) : null,
      vinculo: m ? (m.vinculo || null) : null,
    };
  });

  const porFinal = new Map();
  for (const r of registros) {
    if (!r.final) continue;
    if (!porFinal.has(r.final)) porFinal.set(r.final, []);
    porFinal.get(r.final).push(r);
  }
  for (const lista of porFinal.values()) lista.sort((a, b) => String(a.hora).localeCompare(String(b.hora)));

  // CHECK-IN POR CONTA, NÃO POR FICHA
  //   Em conta compartilhada o check-in cai na ficha do titular, é dele o
  //   Wellhub ID. Então a pergunta é "quantas pessoas desta conta vieram hoje"
  //   contra "quantos check-ins a conta tem hoje": se vieram mais do que
  //   passaram no portal, todas as que vieram ficam marcadas — o sistema não
  //   tem como saber qual delas passou.
  const checkinsPorConta = new Map();
  // `mapaPorMatricula` de um dia só: uma data por check-in, sem varrer a base
  // com os nomes resolvidos como `listar` faria.
  for (const [matriculaId, datas] of checkins.mapaPorMatricula({ de: data, ate: data })) {
    const m = matriculas.porId(matriculaId);
    const conta = m ? (m.contaDe || m.id) : matriculaId;
    checkinsPorConta.set(conta, (checkinsPorConta.get(conta) || 0) + datas.length);
  }

  const vieramPorConta = new Map();
  for (const r of registros) {
    if (r.vinculo !== 'wellhub' || !r.contaId || !r.final) continue;
    if (!vieramPorConta.has(r.contaId)) vieramPorConta.set(r.contaId, new Set());
    vieramPorConta.get(r.contaId).add(r.final);
  }

  const semCheckinWellhub = new Set();
  for (const [conta, finais] of vieramPorConta) {
    if ((checkinsPorConta.get(conta) || 0) < finais.size) {
      for (const f of finais) semCheckinWellhub.add(f);
    }
  }

  return { registros, porFinal, semCheckinWellhub };
}

module.exports = {
  mapaPorMatricula, datasDaMatricula, vinculosComDado, vinculoParaPainel,
  situacao, doDia, finalDoTelefone,
};
