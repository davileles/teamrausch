'use strict';

const crypto = require('crypto');
const { corpoValidacao } = require('./payload-map');

const BASE = (process.env.WELLHUB_API_BASE || 'https://api.partners.gympass.com/access/v1')
  .replace(/\/+$/, '');
const GYM_ID = process.env.WELLHUB_GYM_ID || '';
const API_KEY = process.env.WELLHUB_API_KEY || '';
const AUTH_MODE = process.env.WELLHUB_AUTH_MODE || 'bearer'; // bearer | apikey
const SIMULAR = String(process.env.SIMULAR || 'false') === 'true';
const TIMEOUT_MS = Number(process.env.WELLHUB_TIMEOUT_MS || 8000);

function cabecalhos() {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (AUTH_MODE === 'apikey') h['X-Api-key'] = API_KEY;
  else h.Authorization = `Bearer ${API_KEY}`;
  return h;
}

async function chamar(metodo, caminho, corpo) {
  const controle = new AbortController();
  const t = setTimeout(() => controle.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${BASE}${caminho}`, {
      method: metodo,
      headers: cabecalhos(),
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: controle.signal,
    });
    let dados = null;
    const texto = await resp.text();
    if (texto) { try { dados = JSON.parse(texto); } catch { dados = { texto }; } }
    return { status: resp.status, dados };
  } finally {
    clearTimeout(t);
  }
}

const MOTIVOS = {
  400: 'Check-in inválido ou fora da janela de validade.',
  401: 'Credencial recusada. Confira a API Key e o modo de autenticação.',
  404: 'Nenhum check-in ativo encontrado para este Wellhub ID.',
  409: 'Este check-in já foi validado.',
  429: 'Limite de chamadas atingido. Tente de novo em instantes.',
};

/**
 * Confirma o check-in no Wellhub. É esta chamada que gera o repasse.
 * 200 sem conteúdo = validado.
 */
async function validarAcesso(gympassId, gymId = GYM_ID) {
  if (SIMULAR) {
    return { ok: true, status: 200, simulado: true, motivo: 'Validado em modo simulação.' };
  }
  if (!API_KEY) {
    return { ok: false, status: 0, motivo: 'WELLHUB_API_KEY não configurada.' };
  }
  try {
    const { status, dados } = await chamar('POST', '/validate', corpoValidacao({ gympassId, gymId }));
    if (status >= 200 && status < 300) {
      return { ok: true, status, motivo: 'Acesso validado.', dados };
    }
    return {
      ok: false,
      status,
      motivo: (dados && (dados.message || dados.error)) || MOTIVOS[status] || `Recusado pelo Wellhub (HTTP ${status}).`,
      dados,
    };
  } catch (erro) {
    const abortado = erro.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      rede: true,
      motivo: abortado ? 'Wellhub não respondeu a tempo.' : 'Falha de rede ao falar com o Wellhub.',
    };
  }
}

/** Registra/atualiza/remove o código de acesso (QR, PIN, cartão) no Wellhub. */
async function gravarCodigo(gympassId, codigo, metodo = 'POST') {
  if (SIMULAR) return { ok: true, status: 200, simulado: true };
  const { status, dados } = await chamar(
    metodo,
    `/code/${encodeURIComponent(gympassId)}`,
    metodo === 'DELETE' ? undefined : { gym_id: GYM_ID, code: codigo }
  );
  return { ok: status >= 200 && status < 300, status, dados };
}

/**
 * Confere a assinatura X-Gympass-Signature do webhook.
 * Aceita hex, base64 e prefixo "sha256=" porque o formato exato não está
 * publicado em texto; qualquer um deles fecha com o mesmo segredo.
 */
function assinaturaConfere(corpoBruto, assinaturaRecebida) {
  const segredo = process.env.WELLHUB_WEBHOOK_SECRET || '';
  if (!segredo) return { valida: false, motivo: 'sem-segredo' };
  if (!assinaturaRecebida) return { valida: false, motivo: 'sem-assinatura' };

  const limpa = String(assinaturaRecebida).replace(/^sha256=/i, '').trim();
  const bruto = crypto.createHmac('sha256', segredo).update(corpoBruto).digest();
  const candidatos = [bruto.toString('hex'), bruto.toString('base64')];

  for (const esperada of candidatos) {
    if (esperada.length === limpa.length &&
        crypto.timingSafeEqual(Buffer.from(esperada), Buffer.from(limpa))) {
      return { valida: true };
    }
  }
  return { valida: false, motivo: 'nao-confere' };
}

module.exports = { validarAcesso, gravarCodigo, assinaturaConfere, GYM_ID, SIMULAR };
