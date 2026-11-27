'use strict';

/**
 * app/src/funcional-aviso.js — davileles/teamrausch
 *
 * Pede ao aluno, no WhatsApp, que faça o check-in do Wellhub como
 * Crosstraining em vez de Funcional.
 *
 * POR QUÊ
 *   Para o aluno, Funcional e Crosstraining são o mesmo plano e custam o
 *   mesmo. Para o estúdio, o Crosstraining paga mais por check-in
 *   (config.financeiro). É a perda que se resolve só com um pedido.
 *
 * A PARTIR DA SEGUNDA VEZ
 *   O 1º check-in no Funcional de cada pessoa passa sem mensagem: muitas vezes
 *   é quem está chegando ao estúdio e ainda não sabe, e o estúdio assume esse
 *   erro sem cobrar ninguém. Do 2º em diante, TODA vez que acontecer o aluno
 *   recebe o pedido. A contagem usa o histórico inteiro de check-ins da pessoa
 *   (mesma ficha ou mesmo Wellhub ID), sem zerar no mês.
 *
 * QUEM CHAMA
 *   `gatilhos-mensagens.js` (check-in novo do Wellhub, ~90 s depois) e a
 *   varredura a cada 5 min abaixo, que pega o que ficou fora da janela de
 *   horário, o WhatsApp fora do ar e a ficha vinculada depois.
 *
 * SÓ CHECK-IN RECENTE
 *   Só olha check-ins de hoje e de ontem — ontem para cobrir o check-in feito
 *   à noite, depois da janela, que sai na manhã seguinte. Nada mais antigo vira
 *   mensagem.
 *
 * A PRIMEIRA EXECUÇÃO NÃO ENVIA NADA
 *   O que já existe de hoje/ontem no dia do deploy é só anotado.
 *
 * SEM TELEFONE
 *   Check-in sem ficha (ou ficha sem telefone) não é anotado: se a ficha for
 *   vinculada a tempo (até o fim do dia seguinte), a mensagem sai.
 */

const fs = require('fs');
const path = require('path');

const config = require('./config');
const checkins = require('./checkins-store');
const matriculas = require('./matriculas-store');
const frequencia = require('./frequencia');
const grade = require('./grade');
const modelos = require('./mensagens-store');
const telefone = require('./telefone');
const { enviarTexto, preencher } = require('./mensageiro');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ARQUIVO = path.join(DIR, 'funcional-avisados.json');
/** A partir de qual check-in no Funcional a mensagem sai. */
const A_PARTIR_DE = 2;
/** Anotações mais velhas que isso saem do arquivo (só interessam hoje/ontem). */
const GUARDAR_DIAS = 10;

const TEXTO_PADRAO = 'Oi, {{nome}}! Tudo bem?\n\n'
  + 'Vimos que o seu check-in {{quando}} no Wellhub foi feito como Funcional. '
  + 'Um pedido rápido: nos próximos, escolha Crosstraining.\n\n'
  + 'Para você não muda nada: é o mesmo plano, sem nenhum custo a mais, e o seu treino '
  + 'continua igual.\n'
  + 'Para o estúdio faz diferença, porque o Wellhub repassa um valor maior no Crosstraining. '
  + 'É um jeito simples de dar uma força pra gente no Team Rausch. 💪\n\n'
  + 'Muito obrigado!';

function log(...a) { console.log(new Date().toISOString(), '[funcional]', ...a); }

function dormir(ms) { return new Promise((r) => setTimeout(r, ms)); }

function cfg() {
  try { return config.ler().funcionalAviso || {}; } catch (e) { return {}; }
}

function ativo() { return cfg().ativo !== false; }

function hhmm(v, padrao) {
  const s = String(v || '');
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : padrao;
}

function inicio() { return hhmm(cfg().inicio, '05:00'); }
function fim() { return hhmm(cfg().fim, '21:00'); }

function modeloTexto() { return String(cfg().mensagem || '').trim() || TEXTO_PADRAO; }

function pausaMs() {
  let s;
  try { s = Number((config.ler().mensagens || {}).pausaSegundos); } catch (e) { s = NaN; }
  return Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : 8000;
}

function agoraHHMM() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: process.env.TZ_ESTUDIO || 'America/Sao_Paulo',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
}

function dentroDaJanela() {
  const h = agoraHHMM();
  return h >= inicio() && h < fim();
}

/* -------------------------------- estado --------------------------------- */

let estado = { semeadoEm: null, porCheckin: {} };

(function carregar() {
  try {
    const bruto = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
    estado.semeadoEm = bruto.semeadoEm || null;
    estado.porCheckin = bruto.porCheckin && typeof bruto.porCheckin === 'object'
      ? bruto.porCheckin : {};
  } catch (e) { /* primeira vez */ }
})();

function gravar() {
  try {
    const corte = Date.now() - GUARDAR_DIAS * 86400000;
    for (const [id, v] of Object.entries(estado.porCheckin)) {
      if (!v || Date.parse(v.em || '') < corte) delete estado.porCheckin[id];
    }
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(ARQUIVO, JSON.stringify(estado, null, 2));
  } catch (e) { log('não consegui gravar o estado:', e.message); }
}

function anotar(checkinId, como, ordem) {
  estado.porCheckin[checkinId] = { em: new Date().toISOString(), como, ordem };
}

/* ------------------------------- contagem -------------------------------- */

function ehFuncional(c) { return frequencia.chaveProduto(c && c.produto) === 'funcional'; }

/**
 * Qual check-in no Funcional da pessoa é este (1 = o primeiro de todos).
 * Mesma pessoa = mesma ficha ou mesmo Wellhub ID.
 */
function ordemFuncional(alvo, todos = null) {
  if (!alvo || !ehFuncional(alvo)) return 0;
  const lista = todos || checkins.listar({ limite: Infinity });
  const gp = alvo.gympassId ? String(alvo.gympassId) : null;
  const mid = alvo.matriculaId || null;
  const chaveAlvo = `${alvo.data} ${alvo.hora || ''}`;
  let ordem = 0;
  for (const c of lista) {
    if (!ehFuncional(c)) continue;
    const mesma = (mid && c.matriculaId === mid) || (gp && String(c.gympassId || '') === gp);
    if (!mesma) continue;
    if (c.id === alvo.id || `${c.data} ${c.hora || ''}` <= chaveAlvo) ordem++;
  }
  return ordem;
}

/* -------------------------------- texto ---------------------------------- */

function primeiroNome(nome) {
  return String(nome || '').trim().split(/\s+/)[0] || '';
}

function nomeDoEstudio() {
  try { return String((config.ler().estudio || {}).nome || '').trim(); } catch (e) { return ''; }
}

function quando(data, hoje) {
  if (data === hoje) return 'de hoje';
  if (data === grade.somarDias(hoje, -1)) return 'de ontem';
  const [, m, d] = String(data).split('-');
  return `do dia ${d}/${m}`;
}

function montarTexto(ficha, c, ordem, hoje) {
  const estudio = nomeDoEstudio();
  return preencher(modeloTexto(), {
    nome: primeiroNome(ficha.nome),
    nomeCompleto: ficha.nome || '',
    estudio,
    noEstudio: estudio ? ` no ${estudio}` : '',
    quando: quando(c.data, hoje),
    vezes: String(ordem),
  });
}

/* -------------------------------- envio ---------------------------------- */

/**
 * Uma passada completa.
 * @param {object} opcoes
 * @param {boolean} opcoes.avisar  `false` devolve o que sairia, sem enviar nem anotar.
 * @param {boolean} opcoes.ignorarJanela  envio manual, fora do horário.
 */
async function rodarAgora(opcoes = {}) {
  const simulacao = opcoes.avisar === false;
  const semear = !estado.semeadoEm;
  const hoje = checkins.hojeLocal();
  const ontem = grade.somarDias(hoje, -1);

  const todos = checkins.listar({ limite: Infinity });
  const recentes = todos.filter((c) => c.data >= ontem && c.data <= hoje && ehFuncional(c));

  const pendentes = [];
  const primeiras = [];
  for (const c of recentes) {
    if (estado.porCheckin[c.id]) continue;
    const ordem = ordemFuncional(c, todos);

    if (semear) { if (!simulacao) anotar(c.id, 'semeado', ordem); continue; }

    if (ordem < A_PARTIR_DE) {
      primeiras.push({ nome: c.nomeMatricula || c.nome, data: c.data, hora: c.hora });
      if (!simulacao) anotar(c.id, 'primeira', ordem);
      continue;
    }

    const ficha = c.matriculaId ? matriculas.porId(c.matriculaId) : null;
    pendentes.push({
      checkinId: c.id,
      matriculaId: ficha ? ficha.id : null,
      nome: (ficha && ficha.nome) || c.nomeMatricula || c.nome || 'Sem nome',
      data: c.data,
      hora: c.hora,
      ordem,
      telefone: ficha ? telefone.normalizar(ficha.telefone) : null,
      motivoSemTelefone: ficha ? 'ficha sem telefone' : 'check-in sem ficha',
      texto: montarTexto(ficha || { nome: c.nome }, c, ordem, hoje),
    });
  }

  if (semear) {
    if (simulacao) return { simulacao: true, seraSemeado: true, enviados: 0, pendentes: [] };
    estado.semeadoEm = new Date().toISOString();
    gravar();
    log('primeira passada: check-ins de hoje/ontem anotados, nenhuma mensagem enviada.');
    return { semeado: true, enviados: 0, pendentes: [] };
  }

  if (simulacao) {
    return { simulacao: true, enviados: 0, pendentes, primeiras, foraDaJanela: !dentroDaJanela() };
  }
  if (primeiras.length) gravar();

  if (!pendentes.length) return { enviados: 0, falhas: 0, pendentes };
  if (!opcoes.ignorarJanela && !dentroDaJanela()) {
    return { enviados: 0, falhas: 0, pendentes, adiado: `fora da janela ${inicio()}–${fim()}` };
  }

  let enviados = 0;
  const falhas = [];
  const jaFoi = new Set();   // dois check-ins pendentes da mesma pessoa = uma mensagem
  for (const p of pendentes) {
    if (!p.telefone) { falhas.push({ ...p, motivo: p.motivoSemTelefone }); continue; }
    if (jaFoi.has(p.telefone)) { anotar(p.checkinId, 'junto', p.ordem); gravar(); continue; }

    const r = await enviarTexto(p.telefone, p.texto);
    if (r.ok) { enviados++; jaFoi.add(p.telefone); anotar(p.checkinId, 'enviado', p.ordem); gravar(); }
    else falhas.push({ ...p, motivo: r.motivo });

    modelos.registrar({
      matriculaId: p.matriculaId, nome: p.nome, telefone: p.telefone, texto: p.texto,
      modeloId: null, modeloNome: 'Check-in como Crosstraining', origem: 'funcional',
      ok: r.ok, motivo: r.ok ? null : r.motivo,
    });

    await dormir(pausaMs());
  }

  const reais = falhas.filter((f) => f.telefone);
  if (reais.length) log(`${reais.length} não saiu/saíram:`,
    reais.map((f) => `${f.nome} (${f.motivo})`).join('; '));
  if (enviados) log(`${enviados} pedido(s) de Crosstraining enviado(s).`);

  return { enviados, falhas: falhas.length, pendentes, detalheFalhas: falhas };
}

/** Uma passada por vez: gatilho e varredura não podem ver o mesmo check-in juntos. */
let fila = Promise.resolve();
function rodar(opcoes = {}) {
  const vez = fila.then(() => rodarAgora(opcoes));
  fila = vez.catch(() => {});
  return vez;
}

/* ------------------------------ agendador -------------------------------- */

function iniciar() {
  log(`varredura a cada 5 min, envio entre ${inicio()} e ${fim()}, a partir do ${A_PARTIR_DE}º check-in`
    + `${ativo() ? '' : ' — DESLIGADO na configuração'}.`);

  const tentar = async () => {
    if (!ativo()) return;
    try { await rodar({}); } catch (e) { log('falhou:', e.message); }
  };

  // Depois das outras mensagens automáticas (120–240 s) após um deploy.
  setTimeout(tentar, 300000).unref?.();
  setInterval(tentar, 5 * 60000).unref();
}

function situacao() {
  const contagem = { enviado: 0, primeira: 0, semeado: 0, junto: 0 };
  for (const v of Object.values(estado.porCheckin)) {
    if (v && contagem[v.como] !== undefined) contagem[v.como]++;
  }
  return {
    ativo: ativo(),
    inicio: inicio(),
    fim: fim(),
    aPartirDe: A_PARTIR_DE,
    semeadoEm: estado.semeadoEm,
    ultimosDias: GUARDAR_DIAS,
    ...contagem,
    textoPadrao: TEXTO_PADRAO,
  };
}

module.exports = { iniciar, rodar, situacao, ativo, ordemFuncional, A_PARTIR_DE, TEXTO_PADRAO };
