'use strict';

/**
 * POLLER DO PORTAL — teamrausch/app/src/poller-portal.js
 *
 * A cada N minutos: renova a sessão (refresh_token -> x_session) e consulta a
 * fila. Como a janela de validação do check-in é ~1h30, 15 min dá folga.
 *
 * COMPORTAMENTO PADRÃO = AVISAR, não confirmar.
 *   Confirmar sozinho, sem presença conferida, é o cenário que a Wellhub
 *   fiscaliza ("ao validar você confirma que verificou a identidade"). Por isso
 *   o padrão é só te avisar no WhatsApp que há gente na fila. A confirmação
 *   automática fica atrás de um flag explícito, ligada por sua conta e risco.
 *
 * VARIÁVEIS:
 *   POLLER_PORTAL_ATIVO=true
 *   POLLER_PORTAL_MINUTOS=15
 *   POLLER_PORTAL_AUTO_CONFIRMAR=false   (true = confirma sozinho; risco seu)
 *   WHATSAPP_URL / WHATSAPP_TOKEN        serviço irmão, para os avisos
 *   (+ as variáveis WELLHUB_PORTAL_* usadas por wellhub-portal.js)
 */

const portal = require('./wellhub-portal');

const MINUTOS = Number(process.env.POLLER_PORTAL_MINUTOS || 15);
const AUTO = String(process.env.POLLER_PORTAL_AUTO_CONFIRMAR || 'false') === 'true';

function log(...a) { console.log(new Date().toISOString(), '[poller-portal]', ...a); }

async function avisarWhatsApp(texto) {
  const url = process.env.WHATSAPP_URL;
  if (!url) { log('WHATSAPP_URL não configurado; aviso não enviado.'); return; }
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.WHATSAPP_TOKEN ? { 'x-token': process.env.WHATSAPP_TOKEN } : {}),
      },
      body: JSON.stringify({ mensagem: texto }),
    });
  } catch (e) { log('falha ao avisar WhatsApp:', e.message); }
}

async function rodarUmaVez() {
  // Sessão fresca a cada ciclo (o x_session dura 1h; renovamos sempre).
  try {
    await portal.renovarSessao();
  } catch (e) {
    log('renovarSessao falhou:', e.message);
    await avisarWhatsApp('⚠️ Wellhub: não consegui renovar a sessão. '
      + 'O refresh_token pode ter expirado — gere um novo no portal.');
    return;
  }

  let pendentes;
  try {
    pendentes = await portal.listarPendentes();
  } catch (e) {
    log('listarPendentes falhou:', e.message);
    if (e.sessaoExpirada) await avisarWhatsApp('⚠️ Wellhub: sessão recusada pelo portal.');
    return;
  }

  if (!pendentes.length) { log('fila vazia.'); return; }
  log(`fila com ${pendentes.length} pendente(s).`);

  if (!AUTO) {
    const nomes = pendentes.map((c) => c.nome || c.gympassId || '?').join(', ');
    await avisarWhatsApp(`🟡 Wellhub: ${pendentes.length} check-in(s) para confirmar — ${nomes}`);
    return;
  }

  // AUTO_CONFIRMAR ligado — por sua conta e risco.
  const feitos = [];
  for (const c of pendentes) {
    try {
      const r = await portal.confirmar(c);
      log('confirmar', c.gympassId, r.ok ? 'OK' : `falhou (${r.motivo})`);
      if (r.ok) feitos.push(c.nome || c.gympassId);
    } catch (e) {
      log('confirmar', c.gympassId, 'erro:', e.message);
    }
  }
  if (feitos.length) await avisarWhatsApp(`✅ Wellhub: confirmei ${feitos.length} check-in(s) — ${feitos.join(', ')}`);
}

function iniciar() {
  if (String(process.env.POLLER_PORTAL_ATIVO || 'false') !== 'true') return;
  log(`ligado: a cada ${MINUTOS}min, auto-confirmar=${AUTO}`);
  rodarUmaVez().catch((e) => log('erro:', e.message));
  setInterval(() => rodarUmaVez().catch((e) => log('erro:', e.message)), MINUTOS * 60000);
}

module.exports = { iniciar, rodarUmaVez };
