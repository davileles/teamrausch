'use strict';

/**
 * app/src/historico-aulas.js — davileles/teamrausch
 *
 * Quantas aulas cada aluno já fez, desde sempre — o número que as conquistas
 * usam e que a aba Meus dados mostra.
 *
 * POR QUE ISTO PRECISOU EXISTIR
 *   As duas fontes de aula têm prazo de validade. `agenda-store.limparAntigos`
 *   descarta agendamentos e presenças com mais de 180 dias; `checkins-store`
 *   guarda 400. Quem treina 3x por semana faz ~78 aulas em 180 dias, então uma
 *   conta feita direto em cima dos registros nunca chegaria a "Cem aulas" e o
 *   total do aluno andaria para trás sozinho a cada expurgo. Aqui o número é
 *   acumulado: entra e não sai.
 *
 * COMO A CONTA É FEITA
 *   total(matrícula) = acumulado congelado + dias distintos ainda vivos
 *
 *   `consolidar()` empurra para o acumulado tudo que é mais velho que
 *   JANELA_VIVA_DIAS (90) — bem dentro das duas retenções, então nada se perde
 *   entre uma passada e a próxima. O que é mais recente continua sendo contado
 *   ao vivo, e por isso uma presença apagada à mão ainda some da conta no mesmo
 *   dia. Depois de consolidada, ela não sai mais: é o preço de não depender de
 *   um histórico que o sistema não guarda.
 *
 * O QUE CONTA COMO AULA
 *   Dia distinto com presença: confirmação no tablet da entrada OU check-in do
 *   Wellhub. Dois horários no mesmo dia são uma aula só. Reserva NÃO conta —
 *   parabenizar pelas 50 aulas quem faltou em 12 delas queima a mensagem.
 *
 * A SEMEADURA (uma vez só)
 *   O tablet é novo; presença antiga não existe. Se o número começasse do zero,
 *   todo veterano perderia o histórico da tela de uma vez. Então, na primeira
 *   execução, o acumulado nasce com a melhor conta possível do passado —
 *   reserva passada ∪ check-in ∪ presença — e daí para frente só cresce por
 *   presença. `semeadoEm` marca que isso já aconteceu e não se repete.
 */

const fs = require('fs');
const path = require('path');

const agendaStore = require('./agenda-store');
const checkins = require('./checkins-store');
const matriculas = require('./matriculas-store');
const frequencia = require('./frequencia');
const grade = require('./grade');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ARQUIVO = path.join(DIR, 'historico-aulas.json');

/** Dias recentes que continuam contados ao vivo, fora do acumulado. */
const JANELA_VIVA_DIAS = Number(process.env.HISTORICO_JANELA_DIAS || 90);

function log(...a) { console.log('[historico-aulas]', ...a); }

let dados = { semeadoEm: null, consolidadoAte: null, totais: {} };

(function carregar() {
  try {
    const bruto = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
    dados.semeadoEm = bruto.semeadoEm || null;
    dados.consolidadoAte = bruto.consolidadoAte || null;
    dados.totais = bruto.totais && typeof bruto.totais === 'object' ? bruto.totais : {};
  } catch (e) { /* primeira vez */ }
})();

function gravar() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(ARQUIVO, JSON.stringify(dados, null, 2));
  } catch (e) {
    log('não consegui gravar:', e.message);
  }
}

/* ----------------------------- leitura crua ------------------------------ */

/**
 * Telefone → matrícula, com cache por passada. `porTelefone` varre a base
 * inteira a cada chamada, e uma varredura por presença deixaria a consolidação
 * quadrática numa base que só cresce.
 */
function indiceDeTelefones() {
  const cache = new Map();
  return (telefone) => {
    if (!cache.has(telefone)) {
      const m = matriculas.porTelefone(telefone);
      cache.set(telefone, m ? m.id : null);
    }
    return cache.get(telefone);
  };
}

function acrescentar(mapa, matriculaId, data) {
  if (!matriculaId || !data) return;
  if (!mapa.has(matriculaId)) mapa.set(matriculaId, new Set());
  mapa.get(matriculaId).add(data);
}

/**
 * Dias com presença de verdade, por matrícula, numa janela.
 * @returns {Map<string, Set<string>>}
 */
function diasComPresenca({ de, ate } = {}) {
  const mapa = new Map();
  const daMatricula = indiceDeTelefones();

  for (const p of agendaStore.listarPresencas({ de, ate })) {
    acrescentar(mapa, daMatricula(p.telefone), p.data);
  }
  for (const [matriculaId, datas] of checkins.mapaPorMatricula({ de, ate })) {
    for (const d of datas) acrescentar(mapa, matriculaId, d);
  }
  return mapa;
}

/**
 * Só para a semeadura: acrescenta às presenças os horários reservados que já
 * passaram. É a única conta que o sistema tinha antes do tablet.
 */
function diasDoPassado(ate) {
  const mapa = diasComPresenca({ ate });
  const daMatricula = indiceDeTelefones();
  for (const a of agendaStore.listarAgendamentos({ ate })) {
    if (a.status !== 'ativo') continue;
    acrescentar(mapa, daMatricula(a.telefone), a.data);
  }
  return mapa;
}

/* ---------------------------- consolidação ------------------------------- */

/**
 * Primeira execução: o acumulado nasce com o passado inteiro e a janela viva
 * começa vazia. Sem isto, ligar as conquistas zeraria todo mundo.
 */
function semear() {
  if (dados.semeadoEm) return { semeado: false };
  // O corte fica ONTEM, não hoje: a semeadura roda uma vez e as presenças de
  // hoje ainda estão acontecendo. Congelar o próprio dia faria toda
  // confirmação feita depois desta linha cair num buraco — velha demais para a
  // janela viva e tarde demais para o acumulado.
  const ate = grade.somarDias(frequencia.hojeLocal(), -1);
  const mapa = diasDoPassado(ate);
  const totais = {};
  for (const [matriculaId, dias] of mapa) totais[matriculaId] = dias.size;

  dados = { semeadoEm: new Date().toISOString(), consolidadoAte: ate, totais };
  gravar();
  log(`semeado: ${Object.keys(totais).length} matrícula(s), corte em ${ate}.`);
  return { semeado: true, matriculas: Object.keys(totais).length, ate };
}

/**
 * Empurra para o acumulado tudo que já saiu da janela viva. Idempotente: roda
 * de novo no mesmo dia e não soma nada, porque o corte não se moveu.
 */
function consolidar() {
  if (!dados.semeadoEm) return semear();
  const hoje = frequencia.hojeLocal();
  const corte = grade.somarDias(hoje, -JANELA_VIVA_DIAS);
  if (!dados.consolidadoAte || corte <= dados.consolidadoAte) {
    return { consolidado: false, ate: dados.consolidadoAte };
  }

  const de = grade.somarDias(dados.consolidadoAte, 1);
  const mapa = diasComPresenca({ de, ate: corte });
  let somados = 0;
  for (const [matriculaId, dias] of mapa) {
    dados.totais[matriculaId] = (dados.totais[matriculaId] || 0) + dias.size;
    somados += dias.size;
  }
  dados.consolidadoAte = corte;
  gravar();
  log(`consolidado até ${corte}: +${somados} aula(s) em ${mapa.size} matrícula(s).`);
  return { consolidado: true, ate: corte, somados, matriculas: mapa.size };
}

/* -------------------------------- leitura -------------------------------- */

/** Mapa matriculaId → total de aulas, acumulado + janela viva. */
function totais() {
  const saida = new Map();
  for (const [id, n] of Object.entries(dados.totais)) saida.set(id, Number(n) || 0);

  const de = dados.consolidadoAte ? grade.somarDias(dados.consolidadoAte, 1) : undefined;
  for (const [id, dias] of diasComPresenca({ de })) {
    saida.set(id, (saida.get(id) || 0) + dias.size);
  }
  return saida;
}

function total(matriculaId) {
  if (!matriculaId) return 0;
  const base = Number(dados.totais[matriculaId]) || 0;
  const de = dados.consolidadoAte ? grade.somarDias(dados.consolidadoAte, 1) : undefined;
  const dias = new Set(checkins.datasDaMatricula(matriculaId, { de }));

  const daMatricula = indiceDeTelefones();
  for (const p of agendaStore.listarPresencas({ de })) {
    if (daMatricula(p.telefone) === matriculaId) dias.add(p.data);
  }

  return base + dias.size;
}

/**
 * Os mesmos números por telefone, que é o que a tela do aluno tem na mão.
 * Sem matrícula vinculada não há acumulado: a conta sai da janela viva, e é
 * melhor um número pequeno e verdadeiro do que um número que some depois.
 */
function porTelefone(telefone) {
  const m = matriculas.porTelefone(telefone);
  if (m) return { matriculaId: m.id, total: total(m.id) };

  const de = dados.consolidadoAte ? grade.somarDias(dados.consolidadoAte, 1) : undefined;
  const dias = new Set();
  for (const p of agendaStore.listarPresencas({ de })) {
    if (p.telefone === telefone) dias.add(p.data);
  }
  return { matriculaId: null, total: dias.size };
}

/** Dias distintos com presença de um telefone, dentro do que ainda está vivo. */
function diasVivosDoTelefone(telefone) {
  const dias = new Map();
  for (const p of agendaStore.listarPresencas({})) {
    if (p.telefone !== telefone) continue;
    if (!dias.has(p.data)) dias.set(p.data, []);
    dias.get(p.data).push(p.hora);
  }
  return dias;
}

function situacao() {
  return {
    semeadoEm: dados.semeadoEm,
    consolidadoAte: dados.consolidadoAte,
    janelaVivaDias: JANELA_VIVA_DIAS,
    matriculasComAcumulado: Object.keys(dados.totais).length,
  };
}

module.exports = {
  semear, consolidar, total, totais, porTelefone, diasVivosDoTelefone, situacao,
};
