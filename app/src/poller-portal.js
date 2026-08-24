'use strict';

/**
 * POLLER DO PORTAL — teamrausch/app/src/poller-portal.js
 *
 * A cada N minutos: renova a sessão (refresh_token -> x_session) e consulta a
 * fila. Janela de validação do check-in é ~1h30, então 15 min dá folga.
 *
 * DOIS MODOS:
 *   aviso      (padrão) — só avisa que há gente na fila; você confirma no portal.
 *   automático — confirma sozinho os pendentes. Confirmar sem presença conferida
 *                é o cenário que a Wellhub fiscaliza; é escolha sua.
 *
 * O modo é PERSISTIDO em DATA_DIR/poller-portal.json e pode ser trocado em
 * tempo real pelos endpoints do server.js — sem redeploy e sem mexer no
 * Railway. A variável de ambiente POLLER_PORTAL_AUTO_CONFIRMAR só define o
 * valor inicial, enquanto o arquivo de estado não existir.
 *
 * CANAIS DE AVISO (usa os que estiverem configurados):
 *   - E-mail via Resend  (RESEND_API_KEY presente)
 *   - WhatsApp via Baileys (WHATSAPP_URL presente)
 *
 * VARIÁVEIS:
 *   POLLER_PORTAL_ATIVO=true
 *   POLLER_PORTAL_MINUTOS=15
 *   POLLER_PORTAL_AUTO_CONFIRMAR=false     (só o padrão inicial)
 *   WELLHUB_ALERTA_EMAIL=davileles@gmail.com
 *   RESEND_API_KEY / RESEND_FROM
 *   WHATSAPP_URL / WHATSAPP_TOKEN
 *   DATA_DIR=/data
 *   (+ as WELLHUB_PORTAL_* usadas por wellhub-portal.js)
 */

const fs = require('fs');
const path = require('path');
const portal = require('./wellhub-portal');

const ATIVO = String(process.env.POLLER_PORTAL_ATIVO || 'false') === 'true';
const MINUTOS = Number(process.env.POLLER_PORTAL_MINUTOS || 15);
const AUTO_PADRAO = String(process.env.POLLER_PORTAL_AUTO_CONFIRMAR || 'false') === 'true';
const EMAIL_DESTINO = process.env.WELLHUB_ALERTA_EMAIL || 'davileles@gmail.com';
const EMAIL_FROM = process.env.RESEND_FROM || 'Wellhub Alertas <onboarding@resend.dev>';
const DATA_DIR = process.env.DATA_DIR || '/data';
const ARQ_ESTADO = path.join(DATA_DIR, 'poller-portal.json');

function log(...a) { console.log(new Date().toISOString(), '[poller-portal]', ...a); }

/* ------------------------------------------------------------------------- *
 *  ESTADO PERSISTIDO — sobrevive a restart e deploy
 * ------------------------------------------------------------------------- */

const estado = {
  autoConfirmar: AUTO_PADRAO,
  atualizadoEm: null,
  ultimoCiclo: null,   // relatório do último ciclo (memória, não persistido)
};

(function carregarEstado() {
  try {
    const bruto = JSON.parse(fs.readFileSync(ARQ_ESTADO, 'utf8'));
    if (typeof bruto.autoConfirmar === 'boolean') estado.autoConfirmar = bruto.autoConfirmar;
    estado.atualizadoEm = bruto.atualizadoEm || null;
    log(`estado lido do disco: auto-confirmar=${estado.autoConfirmar}`);
  } catch (e) {
    log(`sem estado no disco; usando o padrão do ambiente: auto-confirmar=${AUTO_PADRAO}`);
  }
})();

function gravarEstado() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ARQ_ESTADO, JSON.stringify({
      autoConfirmar: estado.autoConfirmar,
      atualizadoEm: estado.atualizadoEm,
    }, null, 2));
  } catch (e) {
    log('não consegui gravar o estado no volume:', e.message);
  }
}

function situacao() {
  return {
    ativo: ATIVO,
    autoConfirmar: estado.autoConfirmar,
    modo: estado.autoConfirmar ? 'automatico' : 'aviso',
    minutosDoCiclo: MINUTOS,
    padraoDoAmbiente: AUTO_PADRAO,
    atualizadoEm: estado.atualizadoEm,
    slug: portal.SLUG || null,
    emailAviso: EMAIL_DESTINO,
    ultimoCiclo: estado.ultimoCiclo,
  };
}

function definirAuto(valor, origem = 'api') {
  estado.autoConfirmar = Boolean(valor);
  estado.atualizadoEm = new Date().toISOString();
  gravarEstado();
  log(`auto-confirmar = ${estado.autoConfirmar} (via ${origem})`);
  return situacao();
}

/* ------------------------------------------------------------------------- *
 *  AVISOS
 * ------------------------------------------------------------------------- */

async function enviarEmail(assunto, texto) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { log('RESEND_API_KEY ausente; e-mail não enviado.'); return; }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'authorization': `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: EMAIL_FROM, to: [EMAIL_DESTINO], subject: assunto, text: texto }),
    });
    if (!r.ok) {
      const t = (await r.text().catch(() => '')).slice(0, 200);
      log('e-mail recusado:', r.status, t);
    } else {
      log('e-mail enviado para', EMAIL_DESTINO);
    }
  } catch (e) { log('falha ao enviar e-mail:', e.message); }
}

async function enviarWhatsApp(texto) {
  const url = process.env.WHATSAPP_URL;
  if (!url) return; // canal ainda não configurado
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.WHATSAPP_TOKEN ? { 'x-token': process.env.WHATSAPP_TOKEN } : {}),
      },
      body: JSON.stringify({ mensagem: texto }),
    });
    log('WhatsApp enviado.');
  } catch (e) { log('falha ao avisar WhatsApp:', e.message); }
}

/** Dispara o aviso pelos canais configurados. */
async function avisar(assunto, texto) {
  await enviarEmail(assunto, texto);
  await enviarWhatsApp(texto);
}

/* ------------------------------------------------------------------------- *
 *  CICLO
 * ------------------------------------------------------------------------- */

function rotulo(c) { return c.nome || c.gympassId || '?'; }

/**
 * Roda um ciclo completo e devolve o relatório do que aconteceu.
 * @param {object} opcoes
 *   origem   'ciclo' | 'manual'
 *   avisar   false desliga os e-mails deste ciclo (útil no teste manual)
 */
async function rodarUmaVez(opcoes = {}) {
  const origem = opcoes.origem || 'ciclo';
  const querAvisar = opcoes.avisar !== false;
  const rel = {
    em: new Date().toISOString(),
    origem,
    modo: estado.autoConfirmar ? 'automatico' : 'aviso',
    pendentes: [],
    confirmados: [],
    falhas: [],
    conferidosNoPortal: [],
    naoConferidos: [],
    erro: null,
  };
  estado.ultimoCiclo = rel;

  // Sessão fresca a cada ciclo (o x_session dura 1h; renovamos sempre).
  try {
    await portal.renovarSessao();
  } catch (e) {
    log('renovarSessao falhou:', e.message);
    rel.erro = 'renovarSessao: ' + e.message;
    if (querAvisar) {
      await avisar('⚠️ Wellhub: falha ao renovar sessão',
        'Não consegui renovar a sessão do portal. O refresh_token pode ter expirado — '
        + 'gere um novo no portal e atualize WELLHUB_PORTAL_REFRESH_TOKEN no Railway.');
    }
    return rel;
  }

  let pendentes;
  try {
    pendentes = await portal.listarPendentes();
  } catch (e) {
    log('listarPendentes falhou:', e.message);
    rel.erro = 'listarPendentes: ' + e.message;
    if (querAvisar && e.sessaoExpirada) {
      await avisar('⚠️ Wellhub: sessão recusada', 'O portal recusou a sessão ao listar a fila.');
    }
    return rel;
  }

  rel.pendentes = pendentes.map((c) => ({
    gympassId: c.gympassId, nome: c.nome, produto: c.produto,
    criadoEm: c.criadoEm, expiraEm: c.expiraEm, primeiraVez: c.primeiraVez,
  }));

  if (!pendentes.length) { log('fila vazia.'); return rel; }
  log(`fila com ${pendentes.length} pendente(s).`);

  const nomes = pendentes.map(rotulo).join(', ');

  if (!estado.autoConfirmar) {
    if (querAvisar) {
      await avisar(
        `🟡 Wellhub: ${pendentes.length} check-in(s) para confirmar`,
        `Há ${pendentes.length} check-in(s) aguardando confirmação:\n\n${nomes}\n\n`
        + `Confirme em: https://partners.gympass.com/validation/${portal.SLUG}`
      );
    }
    return rel;
  }

  // Modo automático ligado.
  for (const c of pendentes) {
    try {
      const r = await portal.confirmar(c);
      log('confirmar', c.gympassId, r.ok ? 'OK' : `falhou (${r.motivo})`);
      if (r.ok) rel.confirmados.push({ gympassId: c.gympassId, nome: c.nome });
      else rel.falhas.push({ gympassId: c.gympassId, nome: c.nome, motivo: r.motivo });
    } catch (e) {
      log('confirmar', c.gympassId, 'erro:', e.message);
      rel.falhas.push({ gympassId: c.gympassId, nome: c.nome, motivo: e.message });
    }
  }

  // Conferência de fechamento: o portal precisa mostrar o check-in como validado.
  // Sem isso, "confirmei" é só o que o nosso lado achou que aconteceu.
  if (rel.confirmados.length) {
    try {
      const validados = await portal.listarValidados();
      const idsValidados = new Set(validados.map((v) => String(v.gympassId)));
      for (const c of rel.confirmados) {
        if (idsValidados.has(String(c.gympassId))) rel.conferidosNoPortal.push(c);
        else rel.naoConferidos.push(c);
      }
    } catch (e) {
      log('conferência pós-confirmação falhou:', e.message);
      rel.erro = 'conferencia: ' + e.message;
    }

    if (querAvisar) {
      const conferidos = rel.conferidosNoPortal.map(rotulo).join(', ') || '—';
      const pendura = rel.naoConferidos.length
        ? `\n\nConfirmei mas o portal ainda não mostra como validado: ${rel.naoConferidos.map(rotulo).join(', ')}`
        : '';
      await avisar(`✅ Wellhub: ${rel.confirmados.length} check-in(s) confirmado(s)`,
        `Confirmei automaticamente:\n\n${conferidos}${pendura}`);
    }
  }

  if (rel.falhas.length && querAvisar) {
    await avisar(`⚠️ Wellhub: ${rel.falhas.length} check-in(s) não confirmado(s)`,
      rel.falhas.map((f) => `${rotulo(f)} — ${f.motivo}`).join('\n'));
  }

  return rel;
}

function iniciar() {
  if (!ATIVO) return;
  log(`ligado: a cada ${MINUTOS}min, auto-confirmar=${estado.autoConfirmar}, e-mail=${EMAIL_DESTINO}`);
  rodarUmaVez().catch((e) => log('erro:', e.message));
  setInterval(() => rodarUmaVez().catch((e) => log('erro:', e.message)), MINUTOS * 60000);
}

/** Dispara um aviso de teste imediato (sem depender de check-in na fila). */
async function testarAviso() {
  await avisar('✅ Wellhub: teste de aviso',
    'Este é um e-mail de teste do poller do portal Wellhub.\n\n'
    + 'Se você recebeu isto, o canal de aviso está funcionando.');
  return { ok: true, email: EMAIL_DESTINO, whatsapp: Boolean(process.env.WHATSAPP_URL) };
}

module.exports = { iniciar, rodarUmaVez, testarAviso, situacao, definirAuto };
