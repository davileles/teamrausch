'use strict';

/**
 * app/src/resumo-grupo.js — davileles/teamrausch
 *
 * Junta os avisos de conquista e de meta do mês que iriam para o grupo do
 * operador e manda dois resumos por dia, em vez de uma mensagem a cada aluno.
 *
 * POR QUE
 *   Cada check-in novo dispara os gatilhos, e cada gatilho avisava o grupo na
 *   hora. Num dia cheio o grupo virava um rolo de "🏅 Nova conquista" — a
 *   informação estava lá, mas ninguém lia. Dois resumos batem com os dois
 *   ciclos de atendimento do estúdio: o da manhã (5h às 14h) e o da tarde
 *   (até 21h).
 *
 * O QUE MUDA E O QUE NÃO MUDA
 *   Continuam saindo na hora: o parabéns/agradecimento para o aluno, o aviso
 *   de check-in individual do poller, a lista de aniversariantes e o
 *   relatório diário. Só o AVISO AO GRUPO de conquista e de meta passa por
 *   aqui.
 *
 * NADA SE PERDE EM DEPLOY
 *   Os itens ficam no volume até o resumo sair; quem chegar depois do resumo
 *   das 21h vai no das 14h do dia seguinte. A marca do que já foi enviado
 *   também fica no volume, para três deploys na mesma noite não virarem três
 *   resumos.
 */

const fs = require('fs');
const path = require('path');

const config = require('./config');
const frequencia = require('./frequencia');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ARQUIVO = path.join(DIR, 'resumo-grupo.json');
const HORAS_PADRAO = ['14:00', '21:00'];

function log(...a) { console.log(new Date().toISOString(), '[resumo-grupo]', ...a); }

function cfg() {
  try { return config.ler().resumoGrupo || {}; } catch (e) { return {}; }
}

function ativo() { return cfg().ativo !== false; }

function horas() {
  const lista = Array.isArray(cfg().horas) ? cfg().horas : [];
  const validas = lista.map(String).filter((h) => /^\d{2}:\d{2}$/.test(h));
  return (validas.length ? validas : HORAS_PADRAO).sort();
}

function agoraHHMM() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: process.env.TZ_ESTUDIO || 'America/Sao_Paulo',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
}

/* -------------------------------- estado --------------------------------- */

let estado = { pendentes: { conquistas: [], metas: [] }, enviados: {}, ultimoEnvioEm: null };

(function carregar() {
  try {
    const bruto = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
    const p = bruto.pendentes || {};
    estado.pendentes = {
      conquistas: Array.isArray(p.conquistas) ? p.conquistas : [],
      metas: Array.isArray(p.metas) ? p.metas : [],
    };
    estado.enviados = bruto.enviados && typeof bruto.enviados === 'object' ? bruto.enviados : {};
    estado.ultimoEnvioEm = bruto.ultimoEnvioEm || null;
  } catch (e) { /* primeira vez */ }
})();

function gravar() {
  try {
    // Só o dia de hoje interessa para saber o que já saiu.
    const hoje = frequencia.hojeLocal();
    for (const chave of Object.keys(estado.enviados)) {
      if (!chave.startsWith(hoje)) delete estado.enviados[chave];
    }
    fs.mkdirSync(DIR, { recursive: true });
    const temp = `${ARQUIVO}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(estado, null, 2));
    fs.renameSync(temp, ARQUIVO);
  } catch (e) { log('não consegui gravar o estado:', e.message); }
}

/* ------------------------------- entrada --------------------------------- */

/**
 * Guarda conquistas para o próximo resumo.
 * @param {Array<{nome, emoji, conquista, aulas}>} itens
 */
function conquistas(itens) {
  if (!Array.isArray(itens) || !itens.length) return;
  for (const s of itens) {
    estado.pendentes.conquistas.push({
      nome: s.nome, emoji: s.emoji || '🏅', conquista: s.conquista, aulas: s.aulas,
      em: new Date().toISOString(),
    });
  }
  gravar();
}

/**
 * Guarda metas do mês batidas para o próximo resumo.
 * @param {Array<{nome, realizado, meta, mesNome}>} itens
 */
function metas(itens) {
  if (!Array.isArray(itens) || !itens.length) return;
  for (const s of itens) {
    estado.pendentes.metas.push({
      nome: s.nome, realizado: s.realizado, meta: s.meta, mesNome: s.mesNome,
      em: new Date().toISOString(),
    });
  }
  gravar();
}

/* -------------------------------- texto ---------------------------------- */

function montarTexto(hora) {
  const { conquistas: c, metas: m } = estado.pendentes;
  if (!c.length && !m.length) return null;
  const periodo = hora === horas()[0] ? 'manhã' : 'tarde';
  const linhas = [`📋 *Resumo da ${periodo}* (${hora})`];

  if (c.length) {
    linhas.push('', c.length === 1 ? '🏅 Nova conquista' : `🏅 Novas conquistas (${c.length})`);
    for (const s of c) linhas.push(`• ${s.nome} — ${s.emoji} ${s.conquista} (${s.aulas} aulas)`);
  }
  if (m.length) {
    linhas.push('', m.length === 1 ? '🎯 Meta do mês batida' : `🎯 Metas do mês batidas (${m.length})`);
    for (const s of m) linhas.push(`• ${s.nome} — ${s.realizado}/${s.meta} em ${s.mesNome}`);
  }
  linhas.push('', 'As mensagens já foram para o WhatsApp de cada um. Vale puxar o assunto na porta.');
  return linhas.join('\n');
}

/* -------------------------------- envio ---------------------------------- */

/**
 * Manda o resumo do que está pendente e limpa. Sem nada pendente, só marca o
 * horário como cumprido.
 */
async function enviar(hora) {
  const hoje = frequencia.hojeLocal();
  const chave = `${hoje}|${hora}`;
  const texto = montarTexto(hora);
  if (texto) {
    // Carregado aqui para não fechar ciclo de require com o poller.
    const poller = require('./poller-portal');
    await poller.enviarWhatsApp(texto);
    log(`resumo das ${hora}: ${estado.pendentes.conquistas.length} conquista(s), `
      + `${estado.pendentes.metas.length} meta(s).`);
    estado.pendentes = { conquistas: [], metas: [] };
    estado.ultimoEnvioEm = new Date().toISOString();
  }
  estado.enviados[chave] = true;
  gravar();
  return { hora, enviado: Boolean(texto) };
}

let fila = Promise.resolve();
function rodar(hora) {
  const vez = fila.then(() => enviar(hora || horas()[horas().length - 1]));
  fila = vez.catch(() => {});
  return vez;
}

/* ------------------------------ agendador -------------------------------- */

function iniciar() {
  log(`agendado: resumos às ${horas().join(' e ')}${ativo() ? '' : ' — DESLIGADO na configuração'}.`);

  const tentar = async () => {
    if (!ativo()) return;
    try {
      const hoje = frequencia.hojeLocal();
      const agora = agoraHHMM();
      for (const h of horas()) {
        if (estado.enviados[`${hoje}|${h}`]) continue;
        if (agora < h) continue;
        await rodar(h);
      }
    } catch (e) {
      log('falhou:', e.message);
    }
  };

  setTimeout(tentar, 240000).unref?.();
  setInterval(tentar, 5 * 60000).unref();
}

function situacao() {
  return {
    ativo: ativo(),
    horas: horas(),
    pendentes: {
      conquistas: estado.pendentes.conquistas.length,
      metas: estado.pendentes.metas.length,
    },
    ultimoEnvioEm: estado.ultimoEnvioEm,
    enviadosHoje: Object.keys(estado.enviados),
  };
}

module.exports = { iniciar, rodar, conquistas, metas, situacao };
