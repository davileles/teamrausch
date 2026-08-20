'use strict';

/**
 * ADAPTADOR "PORTAL" — teamrausch/app/src/wellhub-portal.js
 *
 * Ponte enquanto a API oficial (Access Control) não é liberada pela Techsales.
 * Consulta a fila do portal de parceiro (partners.gympass.com) e confirma
 * check-ins pelo mesmo caminho que a tela de validação usa por baixo.
 *
 * TUDO ABAIXO FOI CONFIRMADO EM TESTE REAL (não é chute):
 *
 *  AUTENTICAÇÃO — a API exige TRÊS cookies juntos:
 *    x_session   -> access_token (JWT) do Keycloak. Expira em 1h.
 *                   Gerado por renovarSessao() a partir do refresh_token.
 *    access_key  -> chave da unidade (~400 dias). Estática.
 *    x_fp        -> fingerprint do dispositivo. Estática.
 *    (x_session sozinho = 401 disfarçado de lista vazia; os três juntos = OK.)
 *
 *  CLOUDFRONT — todas as chamadas precisam de user-agent de navegador,
 *    senão voltam 403 "Request blocked".
 *
 *  ENDPOINTS:
 *    Listar:    GET  /gym-partner/api/checkins/<slug>?status=pending|validated|all
 *    Confirmar: POST /gym-partner/validation/api/validate
 *               corpo: { token: <slug>, pass_number: <gympass_id do check-in> }
 *    Renovar:   POST identity.gympass.com/.../token  (grant_type=refresh_token)
 *
 * VARIÁVEIS DE AMBIENTE (Railway):
 *   WELLHUB_PORTAL_SLUG           slug da unidade
 *   WELLHUB_PORTAL_REFRESH_TOKEN  refresh_token do Keycloak (gera o x_session)
 *   WELLHUB_PORTAL_ACCESS_KEY     cookie access_key (estático, ~400 dias)
 *   WELLHUB_PORTAL_FP             cookie x_fp (estático)
 *   WELLHUB_KC_CLIENT             (opcional) client id; padrão 'w4p'
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

const SLUG = process.env.WELLHUB_PORTAL_SLUG || '';
const ACCESS_KEY = process.env.WELLHUB_PORTAL_ACCESS_KEY || '';
const X_FP = process.env.WELLHUB_PORTAL_FP || '';
const TIMEOUT_MS = Number(process.env.WELLHUB_PORTAL_TIMEOUT_MS || 15000);

const API_BASE = 'https://partners.gympass.com/gym-partner/api';
const VALIDATE_URL = 'https://partners.gympass.com/gym-partner/validation/api/validate';

const KC_TOKEN_URL = (process.env.WELLHUB_KC_URL || 'https://identity.gympass.com/auth')
  + '/realms/' + (process.env.WELLHUB_KC_REALM || 'master')
  + '/protocol/openid-connect/token';
const KC_CLIENT = process.env.WELLHUB_KC_CLIENT || 'w4p';

// access_token (JWT) atual, curto. Preenchido por renovarSessao().
let xSession = '';

/** Monta o cabeçalho Cookie com os três cookies exigidos pela API. */
function montarCookie() {
  const partes = [];
  if (xSession)   partes.push('x_session=' + xSession);
  if (ACCESS_KEY) partes.push('access_key=' + ACCESS_KEY);
  if (X_FP)       partes.push('x_fp=' + X_FP);
  return partes.join('; ');
}

/** Cabeçalhos de navegador (o user-agent é obrigatório p/ passar no CloudFront). */
function cabecalhos(extra = {}) {
  return {
    'accept': 'application/json, text/plain, */*',
    'user-agent': UA,
    'referer': `https://partners.gympass.com/validation/${SLUG}`,
    'origin': 'https://partners.gympass.com',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    'cookie': montarCookie(),
    ...extra,
  };
}

async function fetchTimeout(url, opcoes = {}) {
  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, { ...opcoes, signal: controle.signal });
    const texto = await resp.text();
    return { status: resp.status, texto, resp };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------------- *
 *  RENOVAÇÃO DE SESSÃO — refresh_token do Keycloak (OIDC)
 * ------------------------------------------------------------------------- */

async function renovarSessao() {
  const refreshToken = process.env.WELLHUB_PORTAL_REFRESH_TOKEN || '';
  if (!refreshToken) throw new Error('WELLHUB_PORTAL_REFRESH_TOKEN não configurado.');

  const corpo = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: KC_CLIENT,
    refresh_token: refreshToken,
  });

  // user-agent/origin/referer são obrigatórios: sem eles o CloudFront devolve 403.
  const { status, texto } = await fetchTimeout(KC_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': UA,
      'origin': 'https://partners.gympass.com',
      'referer': 'https://partners.gympass.com/',
      'accept': 'application/json',
    },
    body: corpo.toString(),
  });

  let dados = {};
  try { dados = JSON.parse(texto); } catch (e) { /* trata abaixo */ }

  if (status !== 200 || !dados.access_token) {
    const motivo = dados.error_description || dados.error
      || (texto.trim().startsWith('<') ? 'CloudFront bloqueou (403) — verifique o user-agent' : `HTTP ${status}`);
    throw new Error('Falha ao renovar sessão: ' + motivo);
  }

  xSession = dados.access_token;
  if (dados.refresh_token && dados.refresh_token !== refreshToken) {
    console.log(new Date().toISOString(),
      '[wellhub-portal] refresh_token rotacionado — atualize WELLHUB_PORTAL_REFRESH_TOKEN no Railway.');
  }
  return { ok: true, expiraEm: dados.expires_in };
}

/* ------------------------------------------------------------------------- *
 *  LISTAGEM
 * ------------------------------------------------------------------------- */

function lerLista(status, texto) {
  const t = (texto || '').trim();
  if (t.startsWith('<')) {
    const erro = new Error('SESSAO_EXPIRADA: portal devolveu HTML/erro em vez de JSON.');
    erro.sessaoExpirada = true;
    throw erro;
  }
  let dados;
  try { dados = JSON.parse(t || '[]'); }
  catch (e) { throw new Error(`Resposta ilegível (HTTP ${status}): ${t.slice(0, 120)}`); }
  return Array.isArray(dados) ? dados : (dados.data || dados.items || []);
}

/** Schema real confirmado em teste. O campo que confirma é `gympass_id`. */
function normalizar(item) {
  const usuario = item.user || {};
  const produto = item.product || {};
  return {
    id: item.id ?? null,
    passNumber: String(item.gympass_id ?? '').trim() || null,  // <-- vai no POST
    gympassId: String(item.gympass_id ?? '').trim() || null,
    nome: usuario.full_name || null,
    produto: produto.description || null,
    criadoEm: item.checked_in_at || null,
    expiraEm: item.expires_at || null,
    primeiraVez: Boolean(item.first_time_visit),
    original: item,
  };
}

async function listarPorStatus(status) {
  if (!SLUG) throw new Error('WELLHUB_PORTAL_SLUG não configurado.');
  const url = `${API_BASE}/checkins/${encodeURIComponent(SLUG)}?status=${encodeURIComponent(status)}`;
  const { status: http, texto } = await fetchTimeout(url, { headers: cabecalhos() });
  return lerLista(http, texto).map(normalizar);
}

function listarPendentes() { return listarPorStatus('pending'); }
function listarValidados() { return listarPorStatus('validated'); }

/* ------------------------------------------------------------------------- *
 *  CONFIRMAÇÃO
 * ------------------------------------------------------------------------- */

async function confirmar(checkin) {
  const passNumber = checkin && (checkin.passNumber || checkin.gympassId);
  if (!passNumber) return { ok: false, motivo: 'Check-in sem gympass_id.' };

  const { status, texto } = await fetchTimeout(VALIDATE_URL, {
    method: 'POST',
    headers: cabecalhos({ 'content-type': 'application/json' }),
    body: JSON.stringify({ token: SLUG, pass_number: String(passNumber) }),
  });

  if ((texto || '').trim().startsWith('<')) {
    const erro = new Error('SESSAO_EXPIRADA: /validate devolveu HTML.');
    erro.sessaoExpirada = true;
    throw erro;
  }
  const ok = status >= 200 && status < 300;
  return { ok, status, motivo: ok ? 'Confirmado.' : `Recusado (HTTP ${status}): ${texto.slice(0, 160)}` };
}

/* Compatível com wellhub.validarAcesso(): acha o pendente e confirma. */
async function validarAcesso(gympassId) {
  const pendentes = await listarPendentes();
  const alvo = pendentes.find((c) => c.gympassId === String(gympassId));
  if (!alvo) return { ok: false, motivo: 'Nenhum check-in pendente para este aluno.' };
  return confirmar(alvo);
}

module.exports = {
  renovarSessao,
  listarPendentes,
  listarValidados,
  confirmar,
  validarAcesso,
  SLUG,
};
