'use strict';

/**
 * app/src/mural-tv.js — davileles/teamrausch
 *
 * O que a TV do estúdio mostra: aniversariantes do dia, conquistas batidas
 * hoje e ontem, os rankings (frequência do mês, sequência de semanas,
 * evolução, madrugadores, turmas mais cheias e veteranos) e os avisos que
 * estiverem valendo.
 *
 * NADA É GRAVADO AQUI
 *   Tudo é derivado na hora do que já existe. Aniversário vem do mesmo
 *   `aniversariantes-dia.listar` que avisa a recepção às 5h30; a contagem de
 *   aulas vem de `historico-aulas`, a mesma das conquistas e da aba Meus
 *   dados. Uma terceira conta de "quantas aulas" acabaria divergindo, e a TV
 *   parabenizaria por 50 quem o WhatsApp parabenizou por 49.
 *
 * COMO SE SABE QUE O MARCO FOI HOJE OU ONTEM
 *   Um dia conta no máximo uma aula. Então, com o total de agora e sabendo se
 *   houve aula hoje e ontem, dá para voltar no tempo:
 *     fim de ontem   = total − (veio hoje ? 1 : 0)
 *     início de ontem = fim de ontem − (veio ontem ? 1 : 0)
 *   O marco caiu ontem se está entre o início e o fim de ontem; hoje, se está
 *   entre o fim de ontem e o total. Não depende do envio do WhatsApp ter dado
 *   certo — aluno sem telefone também aparece na TV.
 *
 * SÓ NOME E PRIMEIRO SOBRENOME
 *   A rota é aberta, como a do tablet: a TV é só um endereço, sem login para
 *   dar errado num sábado de manhã. Então o que sai daqui é "Ana Silva" e
 *   nunca telefone, plano ou nome completo.
 */

const config = require('./config');
const frequencia = require('./frequencia');
const grade = require('./grade');
const historico = require('./historico-aulas');
const matriculas = require('./matriculas-store');
const aniversariantes = require('./aniversariantes-dia');
const agendaStore = require('./agenda-store');

/** O feed é o mesmo para qualquer TV; montar de novo a cada pedido é à toa. */
const CACHE_MS = 60 * 1000;

/** Muda a cada deploy: o commit no Railway, ou a hora em que o processo subiu. */
const VERSAO = String(process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 12) || String(Date.now());
let cache = { em: 0, feed: null };

function log(...a) { console.log(new Date().toISOString(), '[mural-tv]', ...a); }

function cfg() {
  try { return config.ler().mural || {}; } catch (e) { return {}; }
}

/** Partículas que não contam como sobrenome: "Ana de Souza" → "Ana Souza". */
const PARTICULAS = new Set(['da', 'das', 'de', 'di', 'do', 'dos', 'du', 'e', 'y']);

function capitalizar(s) {
  return s.charAt(0).toLocaleUpperCase('pt-BR') + s.slice(1).toLocaleLowerCase('pt-BR');
}

function palavras(nome) {
  return String(nome || '').trim().split(/\s+/).filter(Boolean);
}

/**
 * "MARIA APARECIDA GONÇALVES DE ALBUQUERQUE" → "Maria Aparecida".
 * Nome e primeiro sobrenome: cabe numa linha da TV e ainda é como a turma
 * chama a pessoa. Partículas ("de", "da"…) são puladas.
 */
function nomeCurto(nome) {
  const p = palavras(nome);
  if (!p.length) return '';
  const sobrenome = p.slice(1).find((x) => !PARTICULAS.has(x.toLowerCase()));
  return sobrenome ? `${capitalizar(p[0])} ${capitalizar(sobrenome)}` : capitalizar(p[0]);
}

/** Desempate: nome, primeiro sobrenome e inicial do último ("Ana Silva S."). */
function nomeMedio(nome) {
  const p = palavras(nome).filter((x, k) => k === 0 || !PARTICULAS.has(x.toLowerCase()));
  const curto = nomeCurto(nome);
  if (p.length < 3) return curto;
  return `${curto} ${p[p.length - 1].charAt(0).toLocaleUpperCase('pt-BR')}.`;
}

function chaveNome(nome) {
  return String(nome || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Troca o nome completo pelo que vai para a tela, sem dois iguais.
 *
 * Mesmo nome completo duas vezes é a mesma pessoa com duas matrículas: sai
 * uma linha só (a primeira da lista, que já vem ordenada pelo mais relevante).
 * Nomes diferentes que dariam o mesmo "Ana Silva" ganham a inicial do último
 * sobrenome — duas linhas idênticas na TV parecem defeito.
 */
function semRepetidos(lista) {
  const vistos = new Set();
  const unicos = lista.filter((x) => {
    const k = chaveNome(x.nomeCompleto);
    if (!k || vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
  const conta = new Map();
  for (const x of unicos) {
    const curto = nomeCurto(x.nomeCompleto);
    conta.set(curto, (conta.get(curto) || 0) + 1);
  }
  return unicos.map((x) => {
    const curto = nomeCurto(x.nomeCompleto);
    const { nomeCompleto, ...resto } = x;
    return { ...resto, nome: conta.get(curto) > 1 ? nomeMedio(nomeCompleto) : curto };
  });
}

/* ------------------------------ aniversário ------------------------------ */

function aniversariantesDeHoje(hoje) {
  try {
    const { alunos } = aniversariantes.listar(hoje);
    return semRepetidos((alunos || []).map((a) => ({ nomeCompleto: a.nome })))
      .map((x) => x.nome)
      .filter(Boolean)
      .sort((x, y) => x.localeCompare(y, 'pt-BR'));
  } catch (e) {
    log('aniversariantes falhou:', e.message);
    return [];
  }
}

/* ------------------------------- conquistas ------------------------------ */

function marcosDoConfig() {
  let lista = [];
  try { lista = config.ler().conquistas || []; } catch (e) { lista = []; }
  return lista
    .filter((m) => Number(m.aulas) > 0)
    .map((m) => ({ aulas: Number(m.aulas), titulo: m.titulo, emoji: m.emoji || '🏅' }))
    .sort((a, b) => a.aulas - b.aulas);
}

function conquistasRecentes(hoje) {
  const marcos = marcosDoConfig();
  if (!marcos.length) return [];

  const ontem = grade.somarDias(hoje, -1);
  let totais; let dias;
  try {
    totais = historico.totais();
    dias = historico.diasComPresenca({ de: ontem, ate: hoje });
  } catch (e) {
    log('conquistas falhou:', e.message);
    return [];
  }

  const saida = [];
  for (const ficha of matriculas.listar()) {
    if (!ficha.ativo) continue;
    const total = totais.get(ficha.id) || 0;
    if (!total) continue;

    const vieram = dias.get(ficha.id) || new Set();
    const fimOntem = total - (vieram.has(hoje) ? 1 : 0);
    const inicioOntem = fimOntem - (vieram.has(ontem) ? 1 : 0);
    if (inicioOntem === total) continue;   // não treinou nem hoje nem ontem

    // Um marco por pessoa, o mais alto — igual ao WhatsApp.
    const batidos = marcos.filter((m) => m.aulas > inicioOntem && m.aulas <= total);
    if (!batidos.length) continue;
    const m = batidos[batidos.length - 1];
    if (!String(ficha.nome || '').trim()) continue;

    saida.push({
      nomeCompleto: ficha.nome, emoji: m.emoji, titulo: m.titulo, aulas: m.aulas,
      quando: m.aulas <= fimOntem ? 'ontem' : 'hoje',
    });
  }

  // Hoje primeiro, depois do marco maior para o menor.
  saida.sort((a, b) => (a.quando === b.quando ? b.aulas - a.aulas : (a.quando === 'hoje' ? -1 : 1)));
  return semRepetidos(saida);
}

/* -------------------------------- rankings ------------------------------- */

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho',
  'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const DIAS_SEMANA = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

/** Quantos dias do mês seguinte ainda mostram o ranking fechado do anterior. */
const DIAS_CAMPEOES_DO_MES_ANTERIOR = 5;

/** Menos que isso não é ranking, é lista de presença. */
const MINIMO_NO_RANKING = 3;

/**
 * Sequência: semanas seguidas com pelo menos este tanto de treinos. A janela
 * fica dentro dos 180 dias que a agenda guarda de presença.
 */
const TREINOS_NA_SEMANA = 2;
const SEMANAS_NA_JANELA = 25;

/** Evolução só faz sentido depois de uma semana de mês. */
const EVOLUCAO_A_PARTIR_DO_DIA = 8;
const EVOLUCAO_MINIMA = 2;

/** Turma mais cheia: média das últimas 4 semanas, com pelo menos 2 aulas dadas. */
const TURMAS_JANELA_DIAS = 28;
const TURMAS_MINIMO_DE_AULAS = 2;

const mesDe = (data) => MESES[Number(String(data).slice(5, 7)) - 1];
const unidade = (n, um, varios) => (Number(n) === 1 ? um : varios);

/** Segunda-feira da semana da data (a semana do estúdio começa na segunda). */
function segundaDaSemana(data) {
  return grade.somarDias(data, -((grade.diaDaSemana(data) + 6) % 7));
}

/** Empate na linha de corte: até quantos a mais ainda cabem na tela. */
const FOLGA_NO_CORTE = 5;

/**
 * Ordena, numera e corta.
 *
 * EMPATE
 *   Empatados dividem a posição (1º, 1º, 3º). `desempate` (opcional) é um
 *   segundo critério que vale mostrar na tela (ex.: treinos dentro da
 *   sequência); só empata quem empata nos dois.
 *
 *   Se o corte do Top N cair no meio de um empate, o grupo empatado entra
 *   inteiro enquanto couber a folga (Top 10 vira até 15 linhas). Passou
 *   disso, o grupo sai inteiro: tirar só alguns por ordem alfabética seria a
 *   TV escolhendo quem merece aparecer.
 */
function posicionar(lista, quantos) {
  const d = (x) => Number(x.desempate) || 0;
  const igual = (a, b) => a.valor === b.valor && d(a) === d(b);
  lista.sort((a, b) => b.valor - a.valor || d(b) - d(a)
    || String(a.nomeCompleto || a.nome).localeCompare(String(b.nomeCompleto || b.nome), 'pt-BR'));
  lista.forEach((x, i) => {
    x.posicao = i > 0 && igual(lista[i - 1], x) ? lista[i - 1].posicao : i + 1;
  });
  let corte = lista.slice(0, quantos);
  const proximo = lista[quantos];
  if (proximo && corte.length && igual(corte[corte.length - 1], proximo)) {
    const grupo = lista.filter((x) => igual(x, proximo));
    corte = lista.slice(0, quantos + grupo.filter((x) => lista.indexOf(x) >= quantos).length);
    if (corte.length > quantos + FOLGA_NO_CORTE) corte = corte.filter((x) => !igual(x, proximo));
  }
  return corte.length < MINIMO_NO_RANKING ? [] : corte;
}

/**
 * Agrupa por pessoa as fichas ativas. Mesma pessoa com duas matrículas (trocou
 * de plano no meio do mês) vira uma só, para não perder posição nem aparecer
 * duas vezes. `porFicha(id)` devolve o que aquela ficha tem; `juntar` soma.
 */
function porPessoa(porFicha, juntar) {
  const mapa = new Map();
  for (const ficha of matriculas.listar()) {
    if (!ficha.ativo) continue;
    const nome = String(ficha.nome || '').trim();
    const dado = porFicha(ficha.id);
    if (!nome || dado == null) continue;
    const k = chaveNome(nome);
    mapa.set(k, mapa.has(k)
      ? { nomeCompleto: mapa.get(k).nomeCompleto, dado: juntar(mapa.get(k).dado, dado) }
      : { nomeCompleto: nome, dado });
  }
  return [...mapa.values()];
}

const uniao = (a, b) => new Set([...a, ...b]);

function diasNaJanela(de, ate) {
  try { return historico.diasComPresenca({ de, ate }); } catch (e) {
    log('ranking: presença falhou:', e.message);
    return new Map();
  }
}

/** Contagem de treinos (dias distintos) por pessoa numa janela. */
function treinosPorPessoa(de, ate) {
  const dias = diasNaJanela(de, ate);
  return porPessoa((id) => (dias.get(id) && dias.get(id).size ? dias.get(id) : null), uniao)
    .map((x) => ({ nomeCompleto: x.nomeCompleto, dias: x.dado }));
}

function slide(tipo, rotulo, titulo, rodape, itens, extra = {}) {
  return itens.length ? { tipo: 'ranking', ranking: tipo, rotulo, titulo, rodape, itens, ...extra } : null;
}

/** Linhas de pessoa: nome curto sem repetidos + valor para a tela. */
function linhas(corte, fmt) {
  return semRepetidos(corte).map((x) => ({ posicao: x.posicao, nome: x.nome, ...fmt(x) }));
}

/* 1. Mais frequentes do mês (e campeões do mês anterior nos primeiros dias) */
function rankingDoMes(hoje, quantos) {
  const saida = [];
  const janela = (de, ate) => posicionar(
    treinosPorPessoa(de, ate).map((x) => ({ nomeCompleto: x.nomeCompleto, valor: x.dias.size })), quantos);
  const fmt = (x) => ({ valor: x.valor, unidade: unidade(x.valor, 'treino', 'treinos') });

  if (Number(hoje.slice(8, 10)) <= DIAS_CAMPEOES_DO_MES_ANTERIOR) {
    const fimAnterior = grade.somarDias(frequencia.inicioDoMes(hoje), -1);
    const mes = mesDe(fimAnterior);
    saida.push(slide('mes-anterior', `Ranking final · ${mes}`, `Campeões de ${mes}`,
      'Resultado fechado do mês. Bora pra cima neste!',
      linhas(janela(frequencia.inicioDoMes(fimAnterior), fimAnterior), fmt)));
  }
  saida.push(slide('mes', `Ranking do mês · ${mesDe(hoje)}`, 'Mais frequentes',
    'Contando até hoje · cada dia com treino vale 1.',
    linhas(janela(frequencia.inicioDoMes(hoje), hoje), fmt)));
  return saida;
}

/* 2. Sequência de semanas com pelo menos 2 treinos */
function rankingSequencia(hoje, quantos) {
  const estaSemana = segundaDaSemana(hoje);
  const inicio = grade.somarDias(estaSemana, -7 * (SEMANAS_NA_JANELA - 1));
  const lista = [];
  for (const p of treinosPorPessoa(inicio, hoje)) {
    const porSemana = new Map();
    for (const d of p.dias) {
      const s = segundaDaSemana(d);
      porSemana.set(s, (porSemana.get(s) || 0) + 1);
    }
    const ok = (s) => (porSemana.get(s) || 0) >= TREINOS_NA_SEMANA;
    // A semana corrente ainda está em andamento: só entra se já bateu a meta.
    let s = ok(estaSemana) ? estaSemana : grade.somarDias(estaSemana, -7);
    let n = 0; let treinos = 0;
    while (s >= inicio && ok(s)) { n += 1; treinos += porSemana.get(s); s = grade.somarDias(s, -7); }
    // A semana corrente conta nos treinos mesmo antes de bater a meta.
    if (!ok(estaSemana)) treinos += porSemana.get(estaSemana) || 0;
    if (n >= 2) lista.push({ nomeCompleto: p.nomeCompleto, valor: n, desempate: treinos });
  }
  return slide('sequencia', 'Constância', 'Semanas seguidas',
    `Semanas seguidas com pelo menos ${TREINOS_NA_SEMANA} treinos · empate: quem treinou mais na sequência.`,
    linhas(posicionar(lista, quantos), (x) => ({
      valor: x.valor >= SEMANAS_NA_JANELA ? `${x.valor}+` : x.valor,
      unidade: unidade(x.valor, 'semana', 'semanas'),
      detalhe: `${x.desempate} treinos na sequência`,
    })));
}

/* 3. Maior evolução: mesmo pedaço do mês, este contra o anterior */
function rankingEvolucao(hoje, quantos) {
  const dia = Number(hoje.slice(8, 10));
  if (dia < EVOLUCAO_A_PARTIR_DO_DIA) return null;
  const fimAnterior = grade.somarDias(frequencia.inicioDoMes(hoje), -1);
  const iniAnterior = frequencia.inicioDoMes(fimAnterior);
  // "Até o dia 23" nos dois meses; fevereiro com 28 dias para no 28.
  const ateAnterior = `${fimAnterior.slice(0, 8)}${String(Math.min(dia, Number(fimAnterior.slice(8, 10)))).padStart(2, '0')}`;

  const atual = diasNaJanela(frequencia.inicioDoMes(hoje), hoje);
  const antes = diasNaJanela(iniAnterior, ateAnterior);
  const par = (id) => {
    const a = atual.get(id); const b = antes.get(id);
    return (a && a.size) || (b && b.size) ? { a: a || new Set(), b: b || new Set() } : null;
  };
  const lista = porPessoa(par, (x, y) => ({ a: uniao(x.a, y.a), b: uniao(x.b, y.b) }))
    .map((x) => ({ nomeCompleto: x.nomeCompleto, agora: x.dado.a.size, antes: x.dado.b.size }))
    // Aluno novo não tem de onde evoluir: o ranking é de quem já vinha.
    .filter((x) => x.antes >= 1 && x.agora - x.antes >= EVOLUCAO_MINIMA)
    .map((x) => ({ ...x, valor: x.agora - x.antes }));

  const mesAnterior = mesDe(fimAnterior);
  return slide('evolucao', 'Evolução', 'Quem mais subiu',
    `Treinos até o dia ${dia}, comparado com o mesmo período de ${mesAnterior}.`,
    linhas(posicionar(lista, quantos), (x) => ({
      valor: `+${x.valor}`, unidade: unidade(x.valor, 'treino', 'treinos'),
      detalhe: `${x.antes} → ${x.agora} treinos`,
    })));
}

/* 4. Madrugadores: dias do mês com treino antes da hora limite */
function rankingMadrugadores(hoje, quantos, limite) {
  const de = frequencia.inicioDoMes(hoje);
  const dias = diasNaJanela(de, hoje);
  let horas;
  try { horas = historico.horaMaisCedoPorDia({ de, ate: hoje }); } catch (e) {
    log('madrugadores falhou:', e.message);
    return null;
  }
  const cedo = (id) => {
    const valendo = dias.get(id); const h = horas.get(id);
    if (!valendo || !h) return null;
    const s = new Set([...valendo].filter((d) => h.has(d) && h.get(d) < limite));
    return s.size ? s : null;
  };
  const lista = porPessoa((id) => {
    const s = cedo(id);
    return s ? { cedo: s, todos: dias.get(id) } : null;
  }, (x, y) => ({ cedo: uniao(x.cedo, y.cedo), todos: uniao(x.todos, y.todos) }))
    .map((x) => ({ nomeCompleto: x.nomeCompleto, valor: x.dado.cedo.size, desempate: x.dado.todos.size }));
  const hora = limite.endsWith(':00') ? `${Number(limite.slice(0, 2))}h` : limite.replace(':', 'h');
  return slide('madrugadores', `Madrugadores · ${mesDe(hoje)}`, `Treino antes das ${hora}`,
    `Dias do mês com treino antes das ${hora} · empate: quem treinou mais no mês.`,
    linhas(posicionar(lista, quantos), (x) => ({
      valor: x.valor, unidade: unidade(x.valor, 'dia', 'dias'), detalhe: `${x.desempate} treinos no mês`,
    })));
}

/* 5. Turmas mais cheias: média de presentes por horário, últimas 4 semanas */
function rankingTurmas(hoje, quantos) {
  const de = grade.somarDias(hoje, -(TURMAS_JANELA_DIAS - 1));
  const porHorario = new Map();   // 'dia|hora' → Map(data → Set(telefone))
  for (const p of agendaStore.listarPresencas({ de, ate: hoje })) {
    const hora = String(p.hora || '').slice(0, 5);
    if (!/^\d{2}:\d{2}$/.test(hora) || !p.data) continue;
    const k = `${grade.diaDaSemana(p.data)}|${hora}`;
    if (!porHorario.has(k)) porHorario.set(k, new Map());
    const datas = porHorario.get(k);
    if (!datas.has(p.data)) datas.set(p.data, new Set());
    datas.get(p.data).add(p.telefone);
  }
  const lista = [];
  for (const [k, datas] of porHorario) {
    if (datas.size < TURMAS_MINIMO_DE_AULAS) continue;
    let soma = 0;
    for (const s of datas.values()) soma += s.size;
    const [d, hora] = k.split('|');
    lista.push({
      nome: `${DIAS_SEMANA[Number(d)]} ${hora}`,
      valor: Math.round((soma / datas.size) * 10) / 10,
    });
  }
  const corte = posicionar(lista, quantos);
  return slide('turmas', 'Turmas em alta', 'Os horários que mais bombam',
    'Onde a energia está lá em cima · média de alunos por aula nas últimas 4 semanas.',
    corte.map((x) => ({
      posicao: x.posicao, nome: x.nome,
      valor: String(x.valor).replace('.', ','), unidade: 'alunos',
    })), { pessoas: false });
}

/* 6. Veteranos: total de aulas desde sempre */
function rankingVeteranos(quantos) {
  let totais;
  try { totais = historico.totais(); } catch (e) {
    log('veteranos falhou:', e.message);
    return null;
  }
  const lista = porPessoa((id) => totais.get(id) || null, (a, b) => a + b)
    .map((x) => ({ nomeCompleto: x.nomeCompleto, valor: x.dado }));
  return slide('veteranos', 'Hall da fama', 'Mais aulas no estúdio',
    'Total de aulas desde que entrou no Team Rausch.',
    linhas(posicionar(lista, quantos), (x) => ({ valor: x.valor, unidade: unidade(x.valor, 'aula', 'aulas') })));
}

/* 7. Presença em dia: quem cumpre o que combinou, não quem vem mais */

/** Mínimo de aulas combinadas na janela para entrar (2x/semana por 2 semanas). */
const PRESENCA_MINIMO_COMBINADAS = 4;
const PRESENCA_PERCENTUAL_MINIMO = 0.9;
/** Nos primeiros dias o mês ainda não tem aula combinada suficiente. */
const PRESENCA_MES_ANTERIOR_ATE_O_DIA = 7;
const PRESENCA_MAXIMO_NA_TV = 30;

/**
 * Aulas combinadas × aulas cumpridas, por pessoa.
 *
 * COMBINADO
 *   Grade fixa da matrícula (com as trocas de grade e as aulas extras, sem as
 *   aulas desmarcadas) + reservas ativas do app. Conta por dia: duas aulas no
 *   mesmo dia são um compromisso só.
 *
 * CUMPRIDO
 *   Qualquer prova de que a pessoa esteve lá naquele dia — check-in do Wellhub
 *   ou confirmação no totem. Aqui não entra a regra do teto do Wellhub: a
 *   pergunta é se ela veio, não se o dia é cobrável.
 *
 * O QUE NÃO VIRA FALTA
 *   Hoje (a aula pode não ter acontecido ainda), datas bloqueadas na agenda e
 *   dias em que ninguém registrou presença no estúdio — dia fechado que não
 *   foi cadastrado não pode derrubar a turma inteira.
 */
function presencaPorPessoa(de, ate) {
  const c = config.ler();
  const bloqueadas = new Set((c.agenda || {}).datasBloqueadas || []);
  const horas = historico.horaMaisCedoPorDia({ de, ate });

  const abertos = new Set();
  for (const dias of horas.values()) for (const d of dias.keys()) abertos.add(d);
  for (const p of agendaStore.listarPresencas({ de, ate })) abertos.add(p.data);

  const reservas = new Map();
  for (const a of agendaStore.listarAgendamentos({ de, ate })) {
    if (a.status !== 'ativo' || !a.telefone) continue;
    if (!reservas.has(a.telefone)) reservas.set(a.telefone, new Set());
    reservas.get(a.telefone).add(a.data);
  }

  const excecoes = matriculas.excecoes({ de, ate });
  const nDias = Math.round((Date.parse(`${ate}T12:00:00Z`) - Date.parse(`${de}T12:00:00Z`)) / 86400000) + 1;
  if (nDias < 1) return [];

  const daFicha = (ficha) => {
    const combinados = new Set(grade.proximasDaMatricula(ficha, excecoes, { de, dias: nDias }).map((x) => x.data));
    for (const d of reservas.get(ficha.telefone) || []) combinados.add(d);
    for (const d of [...combinados]) {
      if (d < de || d > ate || bloqueadas.has(d) || !abertos.has(d)) combinados.delete(d);
    }
    if (!combinados.size) return null;
    const veio = horas.get(ficha.id) || new Map();
    return { c: combinados, p: new Set([...combinados].filter((d) => veio.has(d))) };
  };
  const fichas = new Map(matriculas.listar().map((f) => [f.id, f]));
  return porPessoa((id) => daFicha(fichas.get(id)), (x, y) => ({ c: uniao(x.c, y.c), p: uniao(x.p, y.p) }))
    .map((x) => ({ nomeCompleto: x.nomeCompleto, combinadas: x.dado.c.size, cumpridas: x.dado.p.size }));
}

function rankingPresenca(hoje) {
  const dia = Number(hoje.slice(8, 10));
  let de; let ate; let fechado = false;
  if (dia <= PRESENCA_MES_ANTERIOR_ATE_O_DIA) {
    ate = grade.somarDias(frequencia.inicioDoMes(hoje), -1);
    de = frequencia.inicioDoMes(ate);
    fechado = true;
  } else {
    de = frequencia.inicioDoMes(hoje);
    ate = grade.somarDias(hoje, -1);
  }
  const lista = presencaPorPessoa(de, ate)
    .filter((x) => x.combinadas >= PRESENCA_MINIMO_COMBINADAS
      && x.cumpridas / x.combinadas >= PRESENCA_PERCENTUAL_MINIMO)
    .sort((a, b) => (b.cumpridas / b.combinadas) - (a.cumpridas / a.combinadas)
      || b.combinadas - a.combinadas
      || a.nomeCompleto.localeCompare(b.nomeCompleto, 'pt-BR'))
    .slice(0, PRESENCA_MAXIMO_NA_TV);
  if (lista.length < MINIMO_NO_RANKING) return null;

  const mes = mesDe(ate);
  return slide('presenca', `Compromisso · ${mes}`, fechado ? `Presença em dia em ${mes}` : 'Presença em dia',
    `Foram a pelo menos ${Math.round(PRESENCA_PERCENTUAL_MINIMO * 100)}% das aulas combinadas`
      + (fechado ? ' no mês.' : ' no mês, até ontem.') + ' Não é quem vem mais — é quem cumpre o que marcou.',
    semRepetidos(lista).map((x) => ({
      nome: x.nome,
      completo: x.cumpridas === x.combinadas,
      valor: `${Math.floor((x.cumpridas / x.combinadas) * 100)}%`,
      unidade: '',
      detalhe: `${x.cumpridas} de ${x.combinadas} aulas`,
    })), { semPosicao: true });
}

/* ------------------------------ diagnóstico ------------------------------- */

/**
 * Por que um ranking não apareceu. Só números — nada de nome — porque a rota
 * é aberta como a do feed.
 */
function diagnostico() {
  const hoje = frequencia.hojeLocal();
  const m = cfg();
  const saida = { data: hoje, config: {
    ranking: m.ranking, rankingSequencia: m.rankingSequencia, rankingEvolucao: m.rankingEvolucao,
    rankingMadrugadores: m.rankingMadrugadores, horaMadrugadores: m.horaMadrugadores,
    rankingTurmas: m.rankingTurmas, rankingVeteranos: m.rankingVeteranos, rankingPresenca: m.rankingPresenca,
  } };
  const tenta = (nome, fn) => { try { saida[nome] = fn(); } catch (e) { saida[nome] = { erro: e.message }; } };

  tenta('madrugadores', () => {
    const de = frequencia.inicioDoMes(hoje);
    const horas = historico.horaMaisCedoPorDia({ de, ate: hoje });
    const porHora = {};
    for (const dias of horas.values()) for (const h of dias.values()) {
      const k = h.slice(0, 2);
      porHora[k] = (porHora[k] || 0) + 1;
    }
    const limite = m.horaMadrugadores || '07:00';
    let pessoas = 0;
    for (const dias of horas.values()) if ([...dias.values()].some((h) => h < limite)) pessoas += 1;
    return { limite, pessoasComTreinoAntes: pessoas, diasPorHoraDeChegada: porHora };
  });
  tenta('sequencia', () => {
    const r = rankingSequencia(hoje, 50);
    const t = rankingSequencia(hoje, 10);
    return { pessoasComSequenciaDe2Mais: r ? r.itens.length : 0, noTop10: t ? t.itens.length : 0 };
  });
  tenta('madrugadoresTop', () => {
    const r = rankingMadrugadores(hoje, 5, m.horaMadrugadores || '07:00');
    return { noTop5: r ? r.itens.length : 0 };
  });
  tenta('presenca', () => {
    const dia = Number(hoje.slice(8, 10));
    const ate = dia <= PRESENCA_MES_ANTERIOR_ATE_O_DIA ? grade.somarDias(frequencia.inicioDoMes(hoje), -1) : grade.somarDias(hoje, -1);
    const lista = presencaPorPessoa(frequencia.inicioDoMes(ate), ate);
    const faixas = { '100%': 0, '90-99%': 0, '70-89%': 0, '<70%': 0, 'poucasAulas': 0 };
    for (const x of lista) {
      if (x.combinadas < PRESENCA_MINIMO_COMBINADAS) { faixas.poucasAulas += 1; continue; }
      const p = x.cumpridas / x.combinadas;
      faixas[p === 1 ? '100%' : p >= 0.9 ? '90-99%' : p >= 0.7 ? '70-89%' : '<70%'] += 1;
    }
    return { pessoasComAulaCombinada: lista.length, faixas };
  });
  return saida;
}

/** Top N configurado: 0 desliga, qualquer coisa estranha vira o padrão. */
function topN(valor, padrao) {
  const n = Number(valor === undefined ? padrao : valor);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 10) : 0;
}

function rankings(hoje, m) {
  const saida = [];
  const tenta = (nome, fn) => {
    try {
      const r = fn();
      for (const s of [].concat(r || [])) if (s) saida.push(s);
    } catch (e) { log(`ranking ${nome} falhou:`, e.message); }
  };
  const n = {
    mes: topN(m.ranking, 10),
    sequencia: topN(m.rankingSequencia, 10),
    evolucao: topN(m.rankingEvolucao, 5),
    madrugadores: topN(m.rankingMadrugadores, 5),
    turmas: topN(m.rankingTurmas, 5),
    veteranos: topN(m.rankingVeteranos, 10),
  };
  const limite = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(m.horaMadrugadores || '')) ? m.horaMadrugadores : '07:00';

  if (n.mes) tenta('mes', () => rankingDoMes(hoje, n.mes));
  if (m.rankingPresenca !== false && Number(m.rankingPresenca) !== 0) tenta('presenca', () => rankingPresenca(hoje));
  if (n.sequencia) tenta('sequencia', () => rankingSequencia(hoje, n.sequencia));
  if (n.evolucao) tenta('evolucao', () => rankingEvolucao(hoje, n.evolucao));
  if (n.madrugadores) tenta('madrugadores', () => rankingMadrugadores(hoje, n.madrugadores, limite));
  if (n.turmas) tenta('turmas', () => rankingTurmas(hoje, n.turmas));
  if (n.veteranos) tenta('veteranos', () => rankingVeteranos(n.veteranos));
  return saida;
}

/* --------------------------------- avisos -------------------------------- */

function avisosAtivos(hoje) {
  const c = config.ler();
  const lista = [];

  // O aviso em destaque do app também vale para a TV: é o mesmo recado
  // ("dia 7 não abre"), e cadastrar duas vezes é pedir para um ficar velho.
  const destaque = String((c.estudio || {}).alerta || '').trim();
  const destaqueAte = String((c.estudio || {}).alertaAte || '').trim();
  if (destaque && (!destaqueAte || hoje <= destaqueAte)) lista.push({ texto: destaque });

  for (const a of (cfg().avisos || [])) {
    const texto = String(a.texto || '').trim();
    if (!texto) continue;
    if (a.de && hoje < a.de) continue;
    if (a.ate && hoje > a.ate) continue;
    if (lista.some((x) => x.texto === texto)) continue;
    lista.push({ texto });
  }
  return lista;
}

/* ---------------------------------- feed --------------------------------- */

/** Duas colunas de 5: é o que cabe na tela sem rolar nem encolher a letra. */
const POR_SLIDE_CONQUISTAS = 10;
const POR_SLIDE_ANIVERSARIO = 6;

function montar() {
  const c = config.ler();
  const hoje = frequencia.hojeLocal();
  const m = cfg();

  const aniv = aniversariantesDeHoje(hoje);
  const conq = conquistasRecentes(hoje);
  const avisos = avisosAtivos(hoje);
  const ranks = rankings(hoje, m);

  const slides = [];
  for (let i = 0; i < aniv.length; i += POR_SLIDE_ANIVERSARIO) {
    slides.push({ tipo: 'aniversario', nomes: aniv.slice(i, i + POR_SLIDE_ANIVERSARIO) });
  }
  for (let i = 0; i < conq.length; i += POR_SLIDE_CONQUISTAS) {
    slides.push({ tipo: 'conquistas', itens: conq.slice(i, i + POR_SLIDE_CONQUISTAS) });
  }
  for (const r of ranks) slides.push(r);
  for (const a of avisos) slides.push({ tipo: 'aviso', texto: a.texto });

  const segundos = Number(m.segundosPorSlide);
  return {
    // A TV compara com a versão que carregou e se recarrega sozinha quando o
    // servidor muda. Sem isso, feed novo + página velha dava "0º" na tela.
    versao: VERSAO,
    geradoEm: new Date().toISOString(),
    data: hoje,
    estudio: (c.estudio || {}).nome || '',
    ativo: m.ativo !== false,
    segundosPorSlide: Number.isFinite(segundos) && segundos >= 5 && segundos <= 120 ? segundos : 12,
    slides,
  };
}

function feed() {
  if (cache.feed && Date.now() - cache.em < CACHE_MS) return cache.feed;
  cache = { em: Date.now(), feed: montar() };
  return cache.feed;
}

/** Salvar a configuração tem de aparecer na TV já na próxima volta. */
function invalidar() { cache = { em: 0, feed: null }; }

module.exports = { feed, invalidar, nomeCurto, diagnostico };
