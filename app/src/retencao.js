'use strict';

/**
 * app/src/retencao.js — davileles/teamrausch
 *
 * Duas perguntas de gestão que a Frequência não responde:
 *
 * 1. QUEM ESTÁ SEGURANDO VAGA SEM VIR
 *    A sala tem lugar contado. Aluno com horário fixo que não aparece ocupa a
 *    vaga que um aluno novo poderia ter — e, se for Wellhub, também não gera
 *    repasse, porque o estúdio só recebe pelo check-in. A conta aqui é de
 *    PRESENÇA, não de cobrança: vale o check-in do Wellhub OU a confirmação no
 *    totem, o que vier. O mensalista entra junto (só o totem conta para ele),
 *    porque ele também ocupa lugar na turma.
 *
 *    Combinado = aulas da grade projetadas na janela (sem as desmarcadas, com as
 *    extras), só em dias em que o estúdio funcionou de fato e nunca antes de
 *    `CONTAR_DESDE` (antes disso não havia totem e todo mensalista pareceria
 *    ausente). Veio em outro dia da semana conta como "fora da grade": o aluno
 *    está vivo, mas o horário dele continua vazio.
 *
 * 2. O QUE ACONTECEU COM OS EXPERIMENTAIS
 *    Quem fez aula experimental e virou aluno (e se está vindo), quem continua
 *    marcado como experimental sem decidir, e quem foi inativado sem virar
 *    aluno. É a lista de trabalho para retomar contato.
 *
 *    Um experimental é reconhecido por três rastros: a marca `experimental` na
 *    ficha, a data `alunoDesde` (gravada quando a marca sai) e o registro da
 *    boas-vindas do experimental.
 *
 * NADA É GRAVADO AQUI — tudo é derivado na hora.
 */

const config = require('./config');
const grade = require('./grade');
const frequencia = require('./frequencia');
const historico = require('./historico-aulas');
const matriculas = require('./matriculas-store');
const checkins = require('./checkins-store');
const agendaStore = require('./agenda-store');
const boasVindasExp = require('./boas-vindas-experimental');

const JANELA_PADRAO = 28;
/** Abaixo disso de presença nas aulas da grade o aluno entra como "vem pouco". */
const TAXA_BAIXA = 0.5;
/** Sem aparecer há este tanto de dias (e com aula combinada no período): sumido. */
const DIAS_SUMIDO = 14;

function soDigitos(t) { return String(t || '').replace(/\D/g, ''); }

function diffDias(de, ate) {
  return Math.round((Date.parse(`${ate}T12:00:00Z`) - Date.parse(`${de}T12:00:00Z`)) / 86400000);
}

function dataDe(v) {
  const s = String(v || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/**
 * Telefone da presença → ficha. Diferente de `matriculas.porTelefone`, também
 * acha ficha inativa: o experimental que desistiu precisa aparecer com as aulas
 * que fez. Com mais de uma ficha no mesmo número, a ativa vence.
 */
function indiceDeTelefones(fichas) {
  const porFinal = new Map();
  for (const m of fichas) {
    const t = soDigitos(m.telefone);
    if (t.length < 8) continue;
    const chave = t.slice(-8);
    const atual = porFinal.get(chave);
    if (!atual || (!atual.ativo && m.ativo)) porFinal.set(chave, m);
  }
  return (telefone) => {
    const t = soDigitos(telefone);
    if (t.length < 8) return null;
    const m = porFinal.get(t.slice(-8));
    return m ? m.id : null;
  };
}

/**
 * Dias com presença de cada ficha: check-in do Wellhub ou totem.
 * @returns {Map<string, Set<string>>} matriculaId → datas
 */
function presencasPorFicha(fichas, { de, ate } = {}) {
  const mapa = new Map();
  const anota = (id, data) => {
    if (!id || !data) return;
    if (!mapa.has(id)) mapa.set(id, new Set());
    mapa.get(id).add(data);
  };
  for (const [id, datas] of checkins.mapaPorMatricula({ de, ate })) {
    for (const d of datas) anota(id, d);
  }
  const daFicha = indiceDeTelefones(fichas);
  for (const p of agendaStore.listarPresencas({ de, ate })) anota(daFicha(p.telefone), p.data);
  return mapa;
}

/** Dias em que o estúdio funcionou: alguém registrou presença e a data não está bloqueada. */
function diasAbertos(presencas, { de, ate }) {
  const bloqueadas = new Set((config.ler().agenda || {}).datasBloqueadas || []);
  const abertos = new Set();
  for (const datas of presencas.values()) {
    for (const d of datas) if (d >= de && d <= ate && !bloqueadas.has(d)) abertos.add(d);
  }
  return abertos;
}

function ultimaData(datas) {
  let u = null;
  for (const d of datas || []) if (!u || d > u) u = d;
  return u;
}

/** Aulas combinadas pela grade entre `de` e `ate`, só nos dias abertos. */
function combinadasDe(m, excecoes, de, ate, abertos) {
  if (ate < de) return new Set();
  const lista = grade.proximasDaMatricula(m, excecoes, { de, dias: diffDias(de, ate) + 1 });
  return new Set(lista.map((x) => x.data).filter((d) => d >= de && d <= ate && abertos.has(d)));
}

function resumoDaFicha(m) {
  return {
    id: m.id,
    nome: m.nome,
    telefone: m.telefone || null,
    vinculo: m.vinculo || 'mensalista',
    ativo: Boolean(m.ativo),
    experimental: Boolean(m.experimental),
    grade: (m.grade || []).map((s) => ({ dia: s.dia, hora: s.hora })),
    gradeTexto: grade.gradeEmTexto(m),
    vagasPorSemana: (m.grade || []).length,
  };
}

/* --------------------- 1. vaga ocupada sem presença ---------------------- */

function ocupacaoReal({ dias = JANELA_PADRAO, hoje } = {}) {
  hoje = hoje || frequencia.hojeLocal();
  const n = Math.min(Math.max(Number(dias) || JANELA_PADRAO, 7), 120);
  const ate = grade.somarDias(hoje, -1);   // a aula de hoje ainda pode acontecer
  let de = grade.somarDias(hoje, -n);
  if (historico.CONTAR_DESDE && de < historico.CONTAR_DESDE) de = historico.CONTAR_DESDE;

  const todas = matriculas.listar();
  const presencas = presencasPorFicha(todas, { de, ate });
  const sempre = presencasPorFicha(todas, {});   // última vez, fora da janela
  const abertos = diasAbertos(presencas, { de, ate });
  const excecoes = matriculas.excecoes({ de, ate });
  const inicioMes = frequencia.inicioDoMes(hoje);
  const checkinsMes = checkins.mapaPorMatricula({ de: inicioMes, ate: hoje });

  const alunos = [];
  for (const m of todas) {
    if (!m.ativo || !(m.grade || []).length) continue;
    // Quem acabou de entrar não tem como ter faltado antes de existir.
    const entrada = dataDe(m.alunoDesde) || dataDe(m.criadoEm);
    const inicio = entrada && entrada > de ? entrada : de;
    const combinadas = combinadasDe(m, excecoes, inicio, ate, abertos);
    const veio = presencas.get(m.id) || new Set();
    const cumpridas = [...combinadas].filter((d) => veio.has(d)).length;
    const foraDaGrade = [...veio].filter((d) => d >= inicio && d <= ate && !combinadas.has(d)).length;
    const ultima = ultimaData(sempre.get(m.id));
    const semVir = ultima ? diffDias(ultima, hoje) : null;

    let nivel = 'ok';
    const taxa = combinadas.size ? cumpridas / combinadas.size : null;
    if (combinadas.size >= 2 && (cumpridas === 0 || semVir === null || semVir >= DIAS_SUMIDO)) nivel = 'sumido';
    else if (taxa !== null && combinadas.size >= 2 && taxa < TAXA_BAIXA) nivel = 'baixa';

    const item = {
      ...resumoDaFicha(m),
      desde: inicio,
      combinadas: combinadas.size,
      cumpridas,
      faltas: combinadas.size - cumpridas,
      foraDaGrade,
      taxa: taxa === null ? null : Math.round(taxa * 100),
      ultimaPresenca: ultima,
      diasSemVir: semVir,
      nivel,
    };
    if (item.vinculo === 'wellhub' && !m.contaDe) {
      const inicioPacote = frequencia.inicioDoPacote(m, hoje);
      item.checkinsMes = (checkinsMes.get(m.id) || []).filter((d) => d >= inicioPacote).length;
      item.metaMes = frequencia.metaProporcional(frequencia.metaDoMes(m), inicioPacote, hoje);
    }
    alunos.push(item);
  }

  const peso = { sumido: 0, baixa: 1, ok: 2 };
  alunos.sort((a, b) => peso[a.nivel] - peso[b.nivel]
    || (a.taxa ?? 101) - (b.taxa ?? 101)
    || (a.vinculo === 'wellhub' ? 0 : 1) - (b.vinculo === 'wellhub' ? 0 : 1)
    || a.nome.localeCompare(b.nome, 'pt-BR'));

  const semanas = Math.max((diffDias(de, ate) + 1) / 7, 1);
  const ociosas = alunos.reduce((s, a) => s + a.faltas, 0) / semanas;
  const atencao = alunos.filter((a) => a.nivel !== 'ok');
  return {
    de, ate, hoje, diasPedidos: n,
    truncadaNoCorte: grade.somarDias(hoje, -n) < de,
    criterio: { taxaBaixa: Math.round(TAXA_BAIXA * 100), diasSumido: DIAS_SUMIDO },
    resumo: {
      avaliados: alunos.length,
      sumidos: alunos.filter((a) => a.nivel === 'sumido').length,
      baixa: alunos.filter((a) => a.nivel === 'baixa').length,
      wellhubAtencao: atencao.filter((a) => a.vinculo === 'wellhub').length,
      vagasSemanaAtencao: atencao.reduce((s, a) => s + a.vagasPorSemana, 0),
      aulasVaziasPorSemana: Math.round(ociosas * 10) / 10,
    },
    alunos,
  };
}

/* ---------------------------- 2. experimentais --------------------------- */

function experimentais({ dias = 0, hoje } = {}) {
  hoje = hoje || frequencia.hojeLocal();
  const todas = matriculas.listar();
  const marcados = boasVindasExp.marcados();
  const sempre = presencasPorFicha(todas, {});
  const ontem = grade.somarDias(hoje, -1);
  const corteCriacao = Number(dias) > 0 ? grade.somarDias(hoje, -Number(dias)) : null;

  const lista = [];
  for (const m of todas) {
    // "semeado" = já era experimental quando a boas-vindas entrou no ar.
    const marca = marcados[m.id];
    const foiExperimental = m.experimental || dataDe(m.alunoDesde) || marca;
    if (!foiExperimental) continue;

    const comecou = dataDe(m.criadoEm) || dataDe(marca && marca.em) || null;
    if (corteCriacao && comecou && comecou < corteCriacao) continue;

    const alunoDesde = m.experimental ? null : dataDe(m.alunoDesde);
    const veio = sempre.get(m.id) || new Set();
    const ultima = ultimaData(veio);
    const semVir = ultima ? diffDias(ultima, hoje) : null;
    const aulasExperimental = [...veio].filter((d) => (!comecou || d >= comecou)
      && (!alunoDesde || d < alunoDesde)).length;

    let situacao;
    if (alunoDesde && m.ativo) situacao = 'convertido';
    else if (alunoDesde) situacao = 'saiu';            // virou aluno e depois foi inativado
    else if (m.ativo) situacao = 'aberto';              // continua experimental
    else situacao = 'perdido';                          // inativado sem virar aluno

    const item = {
      ...resumoDaFicha(m),
      situacao,
      comecou,
      alunoDesde,
      diasAteVirar: alunoDesde && comecou ? Math.max(diffDias(comecou, alunoDesde), 0) : null,
      diasEmExperimental: !alunoDesde && m.ativo && comecou ? diffDias(comecou, hoje) : null,
      inativadoEm: m.ativo ? null : dataDe(m.inativadoEm) || dataDe(m.atualizadoEm),
      aulasExperimental,
      aulasTotal: veio.size,
      ultimaPresenca: ultima,
      diasSemVir: semVir,
    };

    // Depois de virar aluno: está vindo nas aulas combinadas?
    if (situacao === 'convertido' && (m.grade || []).length) {
      let de = alunoDesde;
      if (historico.CONTAR_DESDE && de < historico.CONTAR_DESDE) de = historico.CONTAR_DESDE;
      const excecoes = matriculas.excecoes({ de, ate: ontem });
      const abertos = diasAbertos(presencasPorFicha(todas, { de, ate: ontem }), { de, ate: ontem });
      const combinadas = combinadasDe(m, excecoes, de, ontem, abertos);
      const cumpridas = [...combinadas].filter((d) => veio.has(d)).length;
      item.combinadas = combinadas.size;
      item.cumpridas = cumpridas;
      item.taxa = combinadas.size ? Math.round((cumpridas / combinadas.size) * 100) : null;
    }

    // Leitura curta do que fazer com cada um.
    if (situacao === 'convertido') {
      if (semVir !== null && semVir >= DIAS_SUMIDO) item.alerta = 'sumiu';
      else if (item.taxa !== null && item.taxa !== undefined && item.combinadas >= 2
        && item.taxa < TAXA_BAIXA * 100) item.alerta = 'vem-pouco';
      else item.alerta = 'firme';
    } else if (situacao === 'aberto') {
      item.alerta = (item.diasEmExperimental || 0) >= 7 ? 'decidir' : 'recente';
    } else {
      item.alerta = 'retomar';
    }
    lista.push(item);
  }

  const ordem = { aberto: 0, perdido: 1, convertido: 2, saiu: 3 };
  lista.sort((a, b) => ordem[a.situacao] - ordem[b.situacao]
    || String(b.comecou || '').localeCompare(String(a.comecou || ''))
    || a.nome.localeCompare(b.nome, 'pt-BR'));

  const conta = (s) => lista.filter((x) => x.situacao === s).length;
  const decididos = conta('convertido') + conta('saiu') + conta('perdido');
  const viraram = conta('convertido') + conta('saiu');
  const tempos = lista.map((x) => x.diasAteVirar).filter((x) => x !== null);
  return {
    hoje,
    dias: Number(dias) > 0 ? Number(dias) : null,
    resumo: {
      total: lista.length,
      convertidos: conta('convertido'),
      sairamDepois: conta('saiu'),
      abertos: conta('aberto'),
      perdidos: conta('perdido'),
      taxaConversao: decididos ? Math.round((viraram / decididos) * 100) : null,
      mediaDiasParaVirar: tempos.length
        ? Math.round(tempos.reduce((s, x) => s + x, 0) / tempos.length) : null,
      convertidosSumidos: lista.filter((x) => x.alerta === 'sumiu' || x.alerta === 'vem-pouco').length,
    },
    alunos: lista,
  };
}

/** Frequência resumida por ficha, para a Lotação da semana marcar quem não vem. */
function porFicha(opcoes) {
  const r = ocupacaoReal(opcoes);
  const mapa = {};
  for (const a of r.alunos) {
    mapa[a.id] = {
      nivel: a.nivel, taxa: a.taxa, combinadas: a.combinadas, cumpridas: a.cumpridas,
      ultimaPresenca: a.ultimaPresenca, diasSemVir: a.diasSemVir,
    };
  }
  return { de: r.de, ate: r.ate, criterio: r.criterio, porFicha: mapa };
}

module.exports = { ocupacaoReal, experimentais, porFicha, JANELA_PADRAO };
