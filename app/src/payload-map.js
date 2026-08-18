'use strict';

/**
 * ÚNICO PONTO DE AJUSTE DO CONTRATO COM O WELLHUB.
 *
 * O portal de docs (developers.wellhub.com) é renderizado por JavaScript e não
 * expõe o schema em texto puro. Os nomes abaixo seguem o que está documentado
 * publicamente (`gympass_id`, `gym_id`) e leem variações comuns por segurança.
 *
 * Quando a Techsales liberar seu acesso, confira o payload real do
 * "Check-in Webhook" e ajuste SÓ ESTE ARQUIVO.
 */

const TTL_PADRAO_MIN = Number(process.env.CHECKIN_TTL_MINUTES || 60);

/** Lê a primeira chave existente, testando snake_case e camelCase. */
function pega(obj, ...chaves) {
  for (const chave of chaves) {
    const camel = chave.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    for (const k of [chave, camel]) {
      if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
    }
  }
  return undefined;
}

/** Normaliza o corpo do webhook para o formato interno do sistema. */
function lerCheckin(body) {
  const raiz = body && typeof body === 'object' ? (body.data || body.event || body) : {};
  const usuario = raiz.user || raiz.subscriber || raiz;

  const gympassId = String(
    pega(raiz, 'gympass_id', 'wellhub_id', 'user_id') ??
    pega(usuario, 'gympass_id', 'wellhub_id', 'id') ??
    ''
  ).trim();

  const criadoEm = pega(raiz, 'created_at', 'checkin_at', 'timestamp', 'occurred_at');
  const expiraEm = pega(raiz, 'expires_at', 'expiration', 'expire_at');

  const inicio = criadoEm ? new Date(criadoEm) : new Date();
  const validoAte = expiraEm
    ? new Date(expiraEm)
    : new Date(inicio.getTime() + TTL_PADRAO_MIN * 60000);

  return {
    gympassId,
    gymId: String(pega(raiz, 'gym_id', 'partner_id', 'unit_id') ?? '').trim() || null,
    nome: pega(usuario, 'name', 'first_name', 'full_name') || null,
    sobrenome: pega(usuario, 'last_name', 'surname') || null,
    email: pega(usuario, 'email') || null,
    produto: pega(raiz, 'product', 'plan', 'product_name') || null,
    tipo: pega(raiz, 'type', 'event_type', 'checkin_type') || 'checkin',
    criadoEm: inicio.toISOString(),
    validoAte: validoAte.toISOString(),
    payloadOriginal: body,
  };
}

/** Corpo enviado ao endpoint POST /access/v1/validate. */
function corpoValidacao({ gympassId, gymId }) {
  return { gympass_id: gympassId, gym_id: gymId };
}

module.exports = { lerCheckin, corpoValidacao, pega };
