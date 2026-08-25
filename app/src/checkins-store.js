'use strict';

/**
 * app/src/checkins-store.js — davileles/teamrausch
 *
 * Histórico dos check-ins do Wellhub, já vinculados à matrícula do aluno.
 *
 * POR QUE ESTE ARQUIVO EXISTE
 *   O poller confirmava o check-in no portal e esquecia. O relatório do ciclo
 *   vivia só em memória (`estado.ultimoCiclo`) e o aviso por e-mail era a única
 *   marca de que alguém treinou — quer dizer, no dia seguinte não havia como
 *   responder "quantas vezes o Fulano veio esta semana?". Sem essa resposta não
 *   dá para cobrar frequência antes do fim do mês, que é o objetivo.
 *
 * FONTE DOS DADOS
 *   `wellhub-portal.listarValidados()`, lido a cada ciclo do poller. É a lista
 *   que o próprio portal considera validada — cobre tanto o que o modo
 *   automático confirmou quanto o que você confirmou na mão pelo site. Gravar
 *   apenas o que o nosso lado confirmou deixaria buracos nos dias em que o
 *   poller estava em modo aviso.
 *
 * CHAVE DE DEDUPLICAÇÃO: `gympassId|data`
 *   Um aluno por dia. O poller roda a cada 15 min e relê a mesma lista de
 *   validados o dia inteiro; sem essa chave, cada ciclo criaria uma linha nova
 *   e o aluno pareceria ter treinado 30 vezes. Dois treinos do mesmo aluno no
 *   mesmo dia contam como um — que é exatamente como a frequência semanal
 *   combinada é medida.
 *
 * VÍNCULO COM A MATRÍCULA
 *   O Wellhub identifica por `gympass_id`; nós, por nome. A ponte é o campo
 *   `gympassId` da matrícula: quando ele existe, o vínculo é exato. Quando não,
 *   tentamos casar pelo nome normalizado e, dando certo com um único candidato,
 *   gravamos o `gympassId` na matrícula — o casamento por nome acontece uma vez
 *   e daí em diante o vínculo é pelo id. Nome ambíguo ou desconhecido fica sem
 *   vínculo e aparece na tela para você resolver na mão; adivinhar aqui
 *   creditaria treino na ficha errada.
 *
 * Persistência: arquivo próprio no volume + backup no repositório privado,
 * mesma mecânica de `matriculas.json`.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const backupGithub = require('./backup-github');
const grade = require('./grade');
const matriculas = require('./matriculas-store');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ARQUIVO = path.join(DIR, 'checkins.json');
const CAMINHO_BACKUP = process.env.GITHUB_PATH_CHECKINS || 'teamrausch/checkins.json';
const FUSO = process.env.TZ_ESTUDIO || 'America/Sao_Paulo';
const RETENCAO_DIAS = Number(process.env.CHECKINS_RETENCAO_DIAS || 400);

const backup = backupGithub.criar(CAMINHO_BACKUP, 'Check-ins Wellhub');

let dados = { checkins: [] };
let pendente = null;
let semeando = false;

function log(...a) { console.log('[checkins]', ...a); }

/* --------------------------- disco e backup ------------------------------ */

function carregar() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    if (fs.existsSync(ARQUIVO)) {
      const lido = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
      dados.checkins = Array.isArray(lido.checkins) ? lido.checkins : [];
    }
  } catch (erro) {
    console.error('[checkins] não consegui ler, começando vazio:', erro.message);
  }
}

function montar() {
  return JSON.stringify({
    atualizadoEm: new Date().toISOString(),
    total: dados.checkins.length,
    checkins: dados.checkins,
  }, null, 2);
}

function gravar() {
  if (!pendente) {
    pendente = setTimeout(() => {
      pendente = null;
      try {
        fs.mkdirSync(DIR, { recursive: true });
        const temp = `${ARQUIVO}.tmp`;
        fs.writeFileSync(temp, montar());
        fs.renameSync(temp, ARQUIVO);
      } catch (erro) {
        console.error('[checkins] falha ao gravar:', erro.message);
      }
    }, 300);
    if (pendente.unref) pendente.unref();
  }
  backup.sincronizar(montar);
}

/** Volume vazio no primeiro boot: puxa o histórico do backup, como as matrículas. */
async function semear() {
  if (semeando || dados.checkins.length || !backup.ligado) return;
  semeando = true;
  try {
    const remoto = await backup.baixar();
    if (!remoto || !Array.isArray(remoto.checkins) || !remoto.checkins.length) {
      log('sem backup para semear; histórico começa vazio.');
      return;
    }
    if (dados.checkins.length) return;   // chegou check-in enquanto baixava
    dados.checkins = remoto.checkins;
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(ARQUIVO, montar());
    log(`histórico semeado do backup: ${dados.checkins.length} check-ins.`);
  } catch (erro) {
    console.error('[checkins] falha ao semear do backup:', erro.message);
  } finally {
    semeando = false;
  }
}

/* ------------------------------ data e hora ------------------------------ */

/**
 * Data e hora no fuso do estúdio. O portal devolve UTC; um check-in das 21h de
 * São Paulo chega como 00h do dia seguinte, e sem converter ele cairia na
 * semana errada.
 */
function dataLocal(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return hojeLocal();
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

function horaLocal(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: FUSO, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
}

function hojeLocal() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/* ------------------------------- vínculo --------------------------------- */

/**
 * Nome comparável: sem acento, sem pontuação, minúsculo, espaço único.
 * O portal escreve "MARIA DA SILVA", a planilha escreveu "Maria da Silva" —
 * são a mesma pessoa e precisam casar.
 */
function normalizarNome(nome) {
  return String(nome || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .trim().replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * Acha a matrícula de um check-in. Devolve `{ matricula, via }` ou null.
 *
 * Ordem: id do Wellhub já gravado na matrícula, depois nome exato. O nome só
 * vale quando é de um único aluno ativo — dois "Ana Paula" na base derrubam a
 * tentativa em vez de sortear um.
 */
function acharMatricula(reg) {
  const lista = matriculas.listar();

  if (reg.gympassId) {
    const porId = lista.find((m) => String(m.gympassId || '') === String(reg.gympassId));
    if (porId) return { matricula: porId, via: 'wellhub-id' };
  }

  const alvo = normalizarNome(reg.nome);
  if (!alvo) return null;

  const candidatos = lista.filter((m) => m.ativo && normalizarNome(m.nome) === alvo);
  if (candidatos.length === 1) return { matricula: candidatos[0], via: 'nome' };

  // Nome não bate exato: tenta primeiro + último sobrenome, que é como o
  // portal costuma abreviar. Ainda exigindo candidato único.
  const partes = alvo.split(' ');
  if (partes.length >= 2) {
    const curto = `${partes[0]} ${partes[partes.length - 1]}`;
    const porCurto = lista.filter((m) => {
      const n = normalizarNome(m.nome).split(' ');
      if (n.length < 2) return false;
      return m.ativo && `${n[0]} ${n[n.length - 1]}` === curto;
    });
    if (porCurto.length === 1) return { matricula: porCurto[0], via: 'nome' };
  }

  return null;
}

/** Aplica o vínculo no registro e devolve true se conseguiu. */
function vincularAutomatico(reg) {
  const achado = acharMatricula(reg);
  if (!achado) {
    reg.matriculaId = null;
    reg.vinculadoPor = null;
    return false;
  }
  reg.matriculaId = achado.matricula.id;
  reg.nomeMatricula = achado.matricula.nome;
  reg.vinculadoPor = achado.via;

  // Casou pelo nome: grava o id do Wellhub na matrícula para que a próxima vez
  // seja exata. É o que transforma um palpite bom em vínculo permanente.
  if (achado.via === 'nome' && reg.gympassId && !achado.matricula.gympassId) {
    matriculas.definirGympassId(achado.matricula.id, reg.gympassId);
    log(`${achado.matricula.nome}: Wellhub ID ${reg.gympassId} vinculado pelo nome.`);
  }
  return true;
}

/* ------------------------------- registro -------------------------------- */

function novoId() {
  return 'c' + crypto.randomBytes(6).toString('hex');
}

function chave(gympassId, data) {
  return `${String(gympassId || '')}|${data}`;
}

function existente(gympassId, data) {
  const k = chave(gympassId, data);
  return dados.checkins.find((c) => chave(c.gympassId, c.data) === k) || null;
}

/**
 * Grava um check-in validado. Idempotente pela chave `gympassId|data`.
 * @returns {{ novo: boolean, checkin: object }}
 */
function registrar(bruto, origem = 'portal') {
  const gympassId = String(bruto.gympassId ?? bruto.gympass_id ?? '').trim() || null;
  const criadoEm = bruto.criadoEm || bruto.checked_in_at || new Date().toISOString();
  const data = bruto.data || dataLocal(criadoEm);

  const jaTem = gympassId ? existente(gympassId, data) : null;
  if (jaTem) {
    // Registro antigo sem vínculo ganha uma nova chance: a matrícula pode ter
    // sido cadastrada depois do check-in.
    if (!jaTem.matriculaId && vincularAutomatico(jaTem)) gravar();
    return { novo: false, checkin: jaTem };
  }

  const reg = {
    id: novoId(),
    gympassId,
    nome: bruto.nome || null,
    produto: bruto.produto || null,
    data,
    hora: horaLocal(criadoEm),
    criadoEm,
    registradoEm: new Date().toISOString(),
    origem,
    primeiraVez: Boolean(bruto.primeiraVez),
    matriculaId: null,
    nomeMatricula: null,
    vinculadoPor: null,
  };
  vincularAutomatico(reg);

  dados.checkins.push(reg);
  gravar();
  return { novo: true, checkin: reg };
}

/**
 * Grava a lista inteira que veio do portal.
 * @returns {{ novos: number, repetidos: number, semVinculo: number, registros: object[] }}
 */
function registrarLote(lista, origem = 'portal') {
  const registros = [];
  let novos = 0;
  let repetidos = 0;

  for (const item of lista || []) {
    const r = registrar(item, origem);
    if (r.novo) { novos += 1; registros.push(r.checkin); } else repetidos += 1;
  }

  const semVinculo = registros.filter((c) => !c.matriculaId).length;
  if (novos) log(`${novos} check-in(s) novo(s), ${repetidos} repetido(s), ${semVinculo} sem vínculo.`);
  return { novos, repetidos, semVinculo, registros };
}

/** Vínculo manual, feito na tela quando o nome não casou sozinho. */
function vincular(id, matriculaId) {
  const c = dados.checkins.find((x) => x.id === id);
  if (!c) return { ok: false, motivo: 'Check-in não encontrado.' };
  const m = matriculas.porId(matriculaId);
  if (!m) return { ok: false, motivo: 'Matrícula não encontrada.' };

  c.matriculaId = m.id;
  c.nomeMatricula = m.nome;
  c.vinculadoPor = 'manual';

  // Vincular na mão vale para o futuro também: sem gravar o id na matrícula,
  // o mesmo aluno voltaria sem vínculo no dia seguinte.
  if (c.gympassId && String(m.gympassId || '') !== String(c.gympassId)) {
    matriculas.definirGympassId(m.id, c.gympassId);
  }

  // Os outros check-ins órfãos do mesmo id passam a apontar para a matrícula.
  let arrastados = 0;
  for (const outro of dados.checkins) {
    if (outro.id === c.id || outro.matriculaId) continue;
    if (c.gympassId && String(outro.gympassId) === String(c.gympassId)) {
      outro.matriculaId = m.id;
      outro.nomeMatricula = m.nome;
      outro.vinculadoPor = 'manual';
      arrastados += 1;
    }
  }

  gravar();
  return { ok: true, checkin: c, arrastados };
}

/** Desfaz o vínculo (id do Wellhub trocado de dono, erro de digitação). */
function desvincular(id) {
  const c = dados.checkins.find((x) => x.id === id);
  if (!c) return { ok: false, motivo: 'Check-in não encontrado.' };
  c.matriculaId = null;
  c.nomeMatricula = null;
  c.vinculadoPor = null;
  gravar();
  return { ok: true, checkin: c };
}

/**
 * Passa de novo pelos órfãos. Use depois de cadastrar alunos novos ou de
 * corrigir nomes: nada precisa ser reimportado do portal.
 */
function revincularOrfaos() {
  let ligados = 0;
  for (const c of dados.checkins) {
    if (c.matriculaId) continue;
    if (vincularAutomatico(c)) ligados += 1;
  }
  if (ligados) gravar();
  return { ligados, restantes: dados.checkins.filter((c) => !c.matriculaId).length };
}

/* ------------------------------- consultas ------------------------------- */

function listar({ de, ate, matriculaId, gympassId, semVinculo, limite = 500 } = {}) {
  return dados.checkins
    .filter((c) =>
      (!de || c.data >= de) &&
      (!ate || c.data <= ate) &&
      (!matriculaId || c.matriculaId === matriculaId) &&
      (!gympassId || String(c.gympassId) === String(gympassId)) &&
      (!semVinculo || !c.matriculaId))
    .sort((a, b) => b.data.localeCompare(a.data) || String(b.hora).localeCompare(String(a.hora)))
    .slice(0, limite);
}

/** Só as datas em que o aluno treinou, do mais antigo para o mais novo. */
function datasDaMatricula(matriculaId, { de, ate } = {}) {
  return dados.checkins
    .filter((c) => c.matriculaId === matriculaId &&
      (!de || c.data >= de) && (!ate || c.data <= ate))
    .map((c) => c.data)
    .sort();
}

/** Mapa matriculaId → datas, montado uma vez para não varrer a base por aluno. */
function mapaPorMatricula({ de, ate } = {}) {
  const mapa = new Map();
  for (const c of dados.checkins) {
    if (!c.matriculaId) continue;
    if (de && c.data < de) continue;
    if (ate && c.data > ate) continue;
    if (!mapa.has(c.matriculaId)) mapa.set(c.matriculaId, []);
    mapa.get(c.matriculaId).push(c.data);
  }
  for (const lista of mapa.values()) lista.sort();
  return mapa;
}

function ultimoDaMatricula(matriculaId) {
  const meus = dados.checkins.filter((c) => c.matriculaId === matriculaId);
  if (!meus.length) return null;
  return meus.sort((a, b) => b.data.localeCompare(a.data))[0];
}

function resumo() {
  const hoje = hojeLocal();
  const semana = grade.somarDias(hoje, -6);
  const naSemana = dados.checkins.filter((c) => c.data >= semana);
  return {
    total: dados.checkins.length,
    hoje: dados.checkins.filter((c) => c.data === hoje).length,
    ultimos7: naSemana.length,
    semVinculo: dados.checkins.filter((c) => !c.matriculaId).length,
    semVinculo7: naSemana.filter((c) => !c.matriculaId).length,
    primeiroDia: dados.checkins.length
      ? dados.checkins.reduce((a, c) => (c.data < a ? c.data : a), hoje) : null,
  };
}

/** Um pouco mais de um ano de histórico: o suficiente para comparar temporadas. */
function limparAntigos(dias = RETENCAO_DIAS) {
  const corte = grade.somarDias(hojeLocal(), -dias);
  const antes = dados.checkins.length;
  dados.checkins = dados.checkins.filter((c) => c.data >= corte);
  if (dados.checkins.length !== antes) gravar();
}

carregar();
semear();
setInterval(() => limparAntigos(), 24 * 3600000).unref();

module.exports = {
  registrar, registrarLote, vincular, desvincular, revincularOrfaos,
  listar, datasDaMatricula, mapaPorMatricula, ultimoDaMatricula,
  resumo, normalizarNome, dataLocal, hojeLocal, backup,
};
