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
 *   Dia distinto com presença. Dois horários no mesmo dia são uma aula só.
 *   Reserva NÃO conta — parabenizar pelas 50 aulas quem faltou em 12 delas
 *   queima a mensagem.
 *
 *   Aluno Wellhub: todo dia com check-in, mais os dias em que confirmou no
 *   totem SEM check-in, desde que naquele mês ele já tivesse batido o teto de
 *   check-ins do Wellhub (TETO_MES, 12). Passado o teto, quem continua vindo
 *   paga à parte e o check-in não existe mais — o totem é a única prova. Antes
 *   do teto, totem sem check-in é check-in esquecido: não vira aula aqui, para
 *   a conquista não esconder o repasse perdido. A cobrança do Wellhub
 *   (`frequencia.js`) continua só com check-in e não é tocada por esta regra.
 *
 *   Mensalista, ficha dependente de conta compartilhada (o check-in cai no
 *   titular) e telefone sem ficha: a confirmação no totem conta sempre.
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
 * O totem deste dia conta para uma ficha Wellhub? Só sem check-in no dia e com
 * o teto do mês já batido em data anterior. `checkinsDaFicha` precisa cobrir o
 * mês inteiro da data, não só a janela pedida — por isso o chamador busca
 * desde o dia 1º.
 */
function totemContaWellhub(checkinsDaFicha, data) {
  if (checkinsDaFicha.has(data)) return false;   // o dia já conta pelo check-in
  const inicio = frequencia.inicioDoMes(data);
  let antes = 0;
  for (const d of checkinsDaFicha) if (d >= inicio && d < data) antes += 1;
  return antes >= frequencia.TETO_MES;
}

/**
 * Dias com presença de verdade, por matrícula, numa janela.
 * @returns {Map<string, Set<string>>}
 */
function diasComPresenca({ de, ate } = {}) {
  const mapa = new Map();
  const daMatricula = indiceDeTelefones();

  // Check-ins desde o 1º do mês de `de`: a regra do teto olha o mês inteiro.
  const desdeMes = de ? frequencia.inicioDoMes(de) : undefined;
  const checkinsPorFicha = new Map();
  for (const [matriculaId, datas] of checkins.mapaPorMatricula({ de: desdeMes, ate })) {
    checkinsPorFicha.set(matriculaId, new Set(datas));
    for (const d of datas) {
      if (!de || d >= de) acrescentar(mapa, matriculaId, d);
    }
  }

  const fichas = new Map();
  const fichaDe = (id) => {
    if (!fichas.has(id)) fichas.set(id, matriculas.porId(id) || null);
    return fichas.get(id);
  };

  for (const p of agendaStore.listarPresencas({ de, ate })) {
    const matriculaId = daMatricula(p.telefone);
    if (!matriculaId) continue;
    const ficha = fichaDe(matriculaId);
    const regraWellhub = ficha && ficha.vinculo === 'wellhub' && !ficha.contaDe;
    if (regraWellhub
      && !totemContaWellhub(checkinsPorFicha.get(matriculaId) || new Set(), p.data)) continue;
    acrescentar(mapa, matriculaId, p.data);
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
  // Mesma regra de `diasComPresenca` — duas contas diferentes fariam a tela e
  // a mensagem de conquista discordarem do número.
  const dias = diasComPresenca({ de }).get(matriculaId);
  return base + (dias ? dias.size : 0);
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

/**
 * Horário mais cedo em que cada matrícula apareceu em cada dia, juntando o
 * check-in do Wellhub (hora real da catraca) e a confirmação do totem (hora da
 * aula). Serve ao ranking de madrugadores do mural; quem decide se o dia conta
 * como aula continua sendo `diasComPresenca`.
 * @returns {Map<string, Map<string, string>>} matriculaId → data → 'HH:MM'
 */
function horaMaisCedoPorDia({ de, ate } = {}) {
  const mapa = new Map();
  const anota = (id, data, hora) => {
    // A planilha do Wellhub às vezes traz "6:05"; sem o zero, "6:05" > "07:00" como texto.
    const mm = String(hora || '').trim().match(/^(\d{1,2}):(\d{2})/);
    if (!id || !data || !mm) return;
    const h = `${mm[1].padStart(2, '0')}:${mm[2]}`;
    if (!mapa.has(id)) mapa.set(id, new Map());
    const dias = mapa.get(id);
    if (!dias.has(data) || h < dias.get(data)) dias.set(data, h);
  };
  for (const c of checkins.listar({ de, ate, limite: Infinity })) anota(c.matriculaId, c.data, c.hora);
  const daMatricula = indiceDeTelefones();
  for (const p of agendaStore.listarPresencas({ de, ate })) anota(daMatricula(p.telefone), p.data, p.hora);
  return mapa;
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
  // O mural da TV precisa saber em que dia cada aula caiu para dizer se o
  // marco foi batido hoje ou ontem — mesma regra de "o que conta como aula".
  diasComPresenca, horaMaisCedoPorDia,
};
