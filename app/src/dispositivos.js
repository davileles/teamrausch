// ═══════════════════════════════════════════════════════════════════════════
// dispositivos.js — celulares com o app do Team Rausch: entrada por Face ID /
// digital e token de notificação push.
//
// Arquivo: /data/dispositivos.json (volume do Railway, como os outros dados)
//   { dispositivos: [{ id, telefone, plataforma, segredoHash, expiraEm,
//                      pushToken, criadoEm, ultimoUso }] }
//
// Face ID/digital: depois do 1º login (código no WhatsApp) o app pede uma
// chave deste celular. O segredo volta UMA vez, fica no cofre do celular
// protegido pela biometria e aqui só o hash. Nas próximas aberturas o app lê o
// segredo com o Face ID e troca por uma sessão nova. A chave vale 180 dias e
// se renova com o uso; aluno bloqueado não entra.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { enviarPush, pushConfigurado } = require('./push');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ARQUIVO = path.join(DIR, 'dispositivos.json');
const CHAVE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_CELULARES = 5;

let dados = { dispositivos: [] };
let pendente = null;

function carregar() {
  try {
    if (fs.existsSync(ARQUIVO)) {
      const lido = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
      dados = { dispositivos: Array.isArray(lido.dispositivos) ? lido.dispositivos : [] };
    }
  } catch (erro) {
    console.error('[dispositivos] não consegui ler, começando vazio:', erro.message);
  }
}
carregar();

function gravar() {
  if (pendente) return;
  pendente = setTimeout(() => {
    pendente = null;
    try {
      fs.mkdirSync(DIR, { recursive: true });
      const temp = `${ARQUIVO}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(dados, null, 2));
      fs.renameSync(temp, ARQUIVO);
    } catch (erro) {
      console.error('[dispositivos] falha ao gravar:', erro.message);
    }
  }, 300);
}

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function iguais(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
const novoId = () => 'cel-' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
const plataformaValida = (p) => (p === 'ios' || p === 'android' ? p : '');

/** Cria a chave de entrada deste celular. Devolve { id, segredo } (segredo só agora). */
function registrar(telefone, { plataforma, substituir } = {}) {
  plataforma = plataformaValida(plataforma);
  if (!plataforma) return { ok: false, erro: 'plataforma inválida' };
  const lista = dados.dispositivos;
  let pushToken = '';
  // Mesmo celular ativando de novo (reinstalou o app) substitui o registro anterior.
  if (substituir) {
    const i = lista.findIndex((x) => x.id === substituir && x.telefone === telefone);
    if (i >= 0) { pushToken = lista[i].pushToken || ''; lista.splice(i, 1); }
  }
  const meus = lista.filter((x) => x.telefone === telefone && x.segredoHash)
    .sort((a, z) => String(a.ultimoUso || a.criadoEm).localeCompare(String(z.ultimoUso || z.criadoEm)));
  while (meus.length >= MAX_CELULARES) lista.splice(lista.indexOf(meus.shift()), 1);
  const segredo = crypto.randomBytes(32).toString('hex');
  const id = novoId();
  const agora = new Date().toISOString();
  lista.push({
    id, telefone, plataforma, segredoHash: hash(segredo),
    expiraEm: new Date(Date.now() + CHAVE_TTL_MS).toISOString(),
    pushToken, criadoEm: agora, ultimoUso: agora,
  });
  gravar();
  return { ok: true, id, segredo };
}

/** Confere a chave do celular. Devolve { ok, telefone } ou { ok:false, motivo }. */
function conferir(id, segredo) {
  const disp = dados.dispositivos.find((x) => x.id === id);
  if (!disp || !iguais(disp.segredoHash, hash(segredo))) return { ok: false, motivo: 'chave' };
  if (!(new Date(disp.expiraEm).getTime() > Date.now())) return { ok: false, motivo: 'expirada' };
  // Uso renova o prazo da chave (grava no máximo 1x por dia por celular).
  if (Date.now() - new Date(disp.ultimoUso || 0).getTime() > 24 * 60 * 60 * 1000) {
    disp.ultimoUso = new Date().toISOString();
    disp.expiraEm = new Date(Date.now() + CHAVE_TTL_MS).toISOString();
    gravar();
  }
  return { ok: true, telefone: disp.telefone };
}

function remover(telefone, id) {
  const i = dados.dispositivos.findIndex((x) => x.id === id && x.telefone === telefone);
  if (i < 0) return false;
  const disp = dados.dispositivos[i];
  // Desativar o Face ID não desliga o push: o registro fica só com o token.
  if (disp.pushToken) { disp.segredoHash = ''; disp.expiraEm = ''; }
  else dados.dispositivos.splice(i, 1);
  gravar();
  return true;
}

/**
 * Guarda o token de push do celular. Sem id (aluno não usa Face ID), cria um
 * registro só de push. O mesmo token em outra conta (outra pessoa entrou neste
 * celular) sai de lá: notificação de um aluno nunca vai para o celular de outro.
 */
function guardarPush(telefone, { id, plataforma, pushToken } = {}) {
  plataforma = plataformaValida(plataforma);
  pushToken = String(pushToken || '').slice(0, 400);
  if (!plataforma || !pushToken) return { ok: false, erro: 'dados' };
  const lista = dados.dispositivos;
  let disp = id ? lista.find((x) => x.id === id && x.telefone === telefone) : null;
  if (!disp) disp = lista.find((x) => x.telefone === telefone && x.pushToken === pushToken);
  let mudou = false;
  for (const x of lista) if (x !== disp && x.pushToken === pushToken) { x.pushToken = ''; mudou = true; }
  if (!disp) {
    const agora = new Date().toISOString();
    disp = { id: novoId(), telefone, plataforma, segredoHash: '', expiraEm: '', pushToken: '', criadoEm: agora, ultimoUso: agora };
    lista.push(disp);
  }
  if (disp.pushToken !== pushToken) { disp.pushToken = pushToken; disp.plataforma = plataforma; mudou = true; }
  if (mudou) {
    // Registro sem chave de entrada e sem token não serve para nada.
    dados.dispositivos = lista.filter((x) => x.segredoHash || x.pushToken);
    gravar();
  }
  return { ok: true, id: disp.id };
}

/** Celulares do aluno que recebem push. */
function comPush(telefone) {
  return dados.dispositivos.filter((x) => x.telefone === telefone && x.pushToken);
}

/**
 * Manda uma notificação para todos os celulares do aluno com o app.
 * Devolve { enviados, falhas }. Token que a Apple diz que não vale mais é apagado.
 * msg = { titulo, corpo, dados?: { aba } }
 */
async function notificar(telefone, msg) {
  const alvos = comPush(telefone);
  let enviados = 0, falhas = 0;
  for (const disp of alvos) {
    const r = await enviarPush(disp.plataforma, disp.pushToken, msg);
    if (r.ok) enviados++;
    else if (!r.pulado) {
      falhas++;
      if (r.invalido) { disp.pushToken = ''; gravar(); }
      console.warn(`[push] ${telefone.slice(-4)} ${disp.plataforma}: ${r.motivo}`);
    }
  }
  return { enviados, falhas };
}

/** Resumo para a tela de admin (sem telefones nem tokens). */
function estado() {
  const lista = dados.dispositivos;
  return {
    configurado: pushConfigurado(),
    celulares: lista.length,
    comFaceId: lista.filter((x) => x.segredoHash).length,
    comPush: lista.filter((x) => x.pushToken).length,
    alunosComPush: new Set(lista.filter((x) => x.pushToken).map((x) => x.telefone)).size,
  };
}

module.exports = { registrar, conferir, remover, guardarPush, comPush, notificar, estado };
