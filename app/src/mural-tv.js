'use strict';

/**
 * app/src/mural-tv.js — davileles/teamrausch
 *
 * O que a TV do estúdio mostra: aniversariantes do dia, conquistas batidas
 * hoje e ontem, o ranking de frequência do mês e os avisos que estiverem
 * valendo.
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

/** O feed é o mesmo para qualquer TV; montar de novo a cada pedido é à toa. */
const CACHE_MS = 60 * 1000;
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

/* -------------------------------- ranking -------------------------------- */

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho',
  'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

/** Quantos dias do mês seguinte ainda mostram o ranking fechado do anterior. */
const DIAS_CAMPEOES_DO_MES_ANTERIOR = 5;

/** Menos que isso não é ranking, é lista de presença. */
const MINIMO_NO_RANKING = 3;

/**
 * Os que mais vieram numa janela do mês. A conta é a mesma das conquistas
 * (`historico.diasComPresenca`): um dia com treino vale 1, dois horários no
 * mesmo dia continuam valendo 1, e o Wellhub passado do teto conta pelo totem.
 *
 * EMPATE
 *   Empatados dividem a posição (1º, 1º, 3º). Se o corte do Top N cair no meio
 *   de um empate, o grupo empatado sai inteiro: tirar só um deles por ordem
 *   alfabética seria a TV escolhendo quem merece aparecer.
 *
 * MESMA PESSOA, DUAS MATRÍCULAS
 *   Os dias das duas fichas são somados como conjunto antes de contar — quem
 *   trocou de plano no meio do mês não perde posição.
 */
function rankingDaJanela(de, ate, quantos) {
  let dias;
  try {
    dias = historico.diasComPresenca({ de, ate });
  } catch (e) {
    log('ranking falhou:', e.message);
    return [];
  }

  const porPessoa = new Map();
  for (const ficha of matriculas.listar()) {
    if (!ficha.ativo) continue;
    const nome = String(ficha.nome || '').trim();
    const daFicha = dias.get(ficha.id);
    if (!nome || !daFicha || !daFicha.size) continue;
    const k = chaveNome(nome);
    if (!porPessoa.has(k)) porPessoa.set(k, { nomeCompleto: nome, dias: new Set() });
    for (const d of daFicha) porPessoa.get(k).dias.add(d);
  }

  const lista = [...porPessoa.values()]
    .map((x) => ({ nomeCompleto: x.nomeCompleto, aulas: x.dias.size }))
    .sort((a, b) => b.aulas - a.aulas || a.nomeCompleto.localeCompare(b.nomeCompleto, 'pt-BR'));

  // Posição de competição: 1, 1, 3.
  lista.forEach((x, i) => {
    x.posicao = i > 0 && lista[i - 1].aulas === x.aulas ? lista[i - 1].posicao : i + 1;
  });

  let corte = lista.slice(0, quantos);
  const proximo = lista[quantos];
  if (proximo && corte.length && corte[corte.length - 1].aulas === proximo.aulas) {
    corte = corte.filter((x) => x.aulas !== proximo.aulas);
  }
  if (corte.length < MINIMO_NO_RANKING) return [];
  return semRepetidos(corte);
}

function rankings(hoje, quantos) {
  if (!quantos) return [];
  const saida = [];
  const mes = Number(hoje.slice(5, 7));
  const dia = Number(hoje.slice(8, 10));

  // Nos primeiros dias o mês corrente ainda não diz nada: entra o fechado do
  // mês anterior, e o corrente só aparece quando já tiver gente suficiente.
  if (dia <= DIAS_CAMPEOES_DO_MES_ANTERIOR) {
    const fimAnterior = grade.somarDias(frequencia.inicioDoMes(hoje), -1);
    const itens = rankingDaJanela(frequencia.inicioDoMes(fimAnterior), fimAnterior, quantos);
    if (itens.length) {
      saida.push({ tipo: 'ranking', parcial: false, mes: MESES[Number(fimAnterior.slice(5, 7)) - 1], itens });
    }
  }

  const itens = rankingDaJanela(frequencia.inicioDoMes(hoje), hoje, quantos);
  if (itens.length) saida.push({ tipo: 'ranking', parcial: true, mes: MESES[mes - 1], itens });
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
  const rank = Number(m.ranking);
  const ranks = rankings(hoje, Number.isFinite(rank) && rank > 0 ? Math.min(rank, 10) : 0);

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

module.exports = { feed, invalidar, nomeCurto };
