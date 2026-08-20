'use strict';

/**
 * POLLER DO PORTAL — teamrausch/app/src/poller-portal.js
 *
 * A cada N minutos: renova a sessão (refresh_token -> x_session) e consulta a
 * fila. Janela de validação do check-in é ~1h30, então 15 min dá folga.
 *
 * COMPORTAMENTO PADRÃO = AVISAR, não confirmar.
 *   Confirmar sozinho, sem presença conferida, é o cenário que a Wellhub
 *   fiscaliza. Por padrão o poller só te avisa que há gente na fila. A
 *   confirmação automática fica atrás de um flag, ligada por sua conta e risco.
 *
 * CANAIS DE AVISO (usa os que estiverem configurados):
 *   - E-mail via Resend  (RESEND_API_KEY presente)  -> ativo agora
 *   - WhatsApp via Baileys (WHATSAPP_URL presente)   -> quando o chip existir
 *
 * VARIÁVEIS:
 *   POLLER_PORTAL_ATIVO=true
 *   POLLER_PORTAL_MINUTOS=15
 *   POLLER_PORTAL_AUTO_CONFIRMAR=false     (true = confirma sozinho; risco seu)
 *   WELLHUB_ALERTA_EMAIL=davileles@gmail.com   (destino do aviso)
 *   RESEND_API_KEY                          (já existe no ecossistema)
 *   RESEND_FROM                             (remetente; ver nota abaixo)
 *   WHATSAPP_URL / WHATSAPP_TOKEN           (canal WhatsApp, opcional)
 *   (+ as WELLHUB_PORTAL_* usadas por wellhub-portal.js)
 *
 * NOTA sobre RESEND_FROM: o Resend exige um remetente de domínio verificado na
 * sua conta. Defina RESEND_FROM com um endereço desse domínio (ex.:
 * 'Wellhub <alertas@clubedoviajante.com.br>'). O padrão abaixo usa o remetente
 * compartilhado do Resend, que funciona sem verificar domínio mas pode cair em
 * spam — bom para testar, troque depois.
 */

const portal = require('./wellhub-portal');

const MINUTOS = Number(process.env.POLLER_PORTAL_MINUTOS || 15);
const AUTO = String(process.env.POLLER_PORTAL_AUTO_CONFIRMAR || 'false') === 'true';
const EMAIL_DESTINO = process.env.WELLHUB_ALERTA_EMAIL || 'davileles@gmail.com';
const EMAIL_FROM = process.env.RESEND_FROM || 'Wellhub Alertas <onboarding@resend.dev>';

function log(...a) { console.log(new Date().toISOString(), '[poller-portal]', ...a); }

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

/** Dispara o aviso pelos canais configurados (e-mail agora, WhatsApp quando houver). */
async function avisar(assunto, texto) {
  await enviarEmail(assunto, texto);
  await enviarWhatsApp(texto);
}

async function rodarUmaVez() {
  // Sessão fresca a cada ciclo (o x_session dura 1h; renovamos sempre).
  try {
    await portal.renovarSessao();
  } catch (e) {
    log('renovarSessao falhou:', e.message);
    await avisar('⚠️ Wellhub: falha ao renovar sessão',
      'Não consegui renovar a sessão do portal. O refresh_token pode ter expirado — '
      + 'gere um novo no portal e atualize WELLHUB_PORTAL_REFRESH_TOKEN no Railway.');
    return;
  }

  let pendentes;
  try {
    pendentes = await portal.listarPendentes();
  } catch (e) {
    log('listarPendentes falhou:', e.message);
    if (e.sessaoExpirada) {
      await avisar('⚠️ Wellhub: sessão recusada', 'O portal recusou a sessão ao listar a fila.');
    }
    return;
  }

  if (!pendentes.length) { log('fila vazia.'); return; }
  log(`fila com ${pendentes.length} pendente(s).`);

  const nomes = pendentes.map((c) => c.nome || c.gympassId || '?').join(', ');

  if (!AUTO) {
    await avisar(
      `🟡 Wellhub: ${pendentes.length} check-in(s) para confirmar`,
      `Há ${pendentes.length} check-in(s) aguardando confirmação:\n\n${nomes}\n\n`
      + `Confirme em: https://partners.gympass.com/validation/${portal.SLUG}`
    );
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
  if (feitos.length) {
    await avisar(`✅ Wellhub: ${feitos.length} check-in(s) confirmado(s)`,
      `Confirmei automaticamente:\n\n${feitos.join(', ')}`);
  }
}

function iniciar() {
  if (String(process.env.POLLER_PORTAL_ATIVO || 'false') !== 'true') return;
  log(`ligado: a cada ${MINUTOS}min, auto-confirmar=${AUTO}, e-mail=${EMAIL_DESTINO}`);
  rodarUmaVez().catch((e) => log('erro:', e.message));
  setInterval(() => rodarUmaVez().catch((e) => log('erro:', e.message)), MINUTOS * 60000);
}

module.exports = { iniciar, rodarUmaVez };
