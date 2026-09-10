'use strict';

/**
 * app/src/anexos-store.js — davileles/teamrausch
 *
 * Arquivos anexados ao disparo de mensagens (imagem, PDF, vídeo…).
 *
 * POR QUE O ARQUIVO SOBE UMA VEZ SÓ
 *   O disparo em massa chama POST /mensagens/enviar uma vez por aluno. Mandar
 *   o arquivo junto em cada chamada faria o navegador subir os mesmos 5 MB
 *   cem vezes — pelo 4G do celular, muitas vezes. A tela sobe o arquivo aqui
 *   ao anexar, recebe um id, e cada envio só cita o id.
 *
 * O ID É O HASH DO CONTEÚDO
 *   Anexar de novo o mesmo arquivo devolve o mesmo id. Isso deixa retomar um
 *   lote interrompido sem duplicar nada no disco, e se o volume tiver perdido
 *   o arquivo, basta anexar de novo que o id volta a valer.
 *
 * Fica no volume (DATA_DIR/anexos) e é apagado depois de DIAS_DE_VIDA. Não vai
 * para o backup do GitHub: é material de passagem, não registro.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'anexos');
const LIMITE_BYTES = 16 * 1024 * 1024;
const DIAS_DE_VIDA = Number(process.env.ANEXOS_DIAS_DE_VIDA || 7);
const RE_ID = /^ANX-[a-f0-9]{24}$/;

function log(...a) { console.log('[anexos]', ...a); }

function caminhos(id) {
  return { bin: path.join(DIR, `${id}.bin`), meta: path.join(DIR, `${id}.json`) };
}

function limparVencidos() {
  try {
    if (!fs.existsSync(DIR)) return;
    const corte = Date.now() - DIAS_DE_VIDA * 86400000;
    for (const nome of fs.readdirSync(DIR)) {
      const arq = path.join(DIR, nome);
      try {
        if (fs.statSync(arq).mtimeMs < corte) fs.unlinkSync(arq);
      } catch (_) { /* arquivo sumiu entre a listagem e o stat */ }
    }
  } catch (e) { log('falha na limpeza:', e.message); }
}

/** Nome vem do navegador: sem barra, sem caractere de controle, com tamanho limitado. */
function nomeSeguro(nome) {
  const limpo = String(nome || '').replace(/[\\/\u0000-\u001f]/g, '').trim().slice(0, 120);
  return limpo || 'arquivo';
}

function tipoSeguro(tipo) {
  const t = String(tipo || '').toLowerCase().trim();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(t) ? t : 'application/octet-stream';
}

function salvar(buffer, { nome, tipo } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { ok: false, motivo: 'Arquivo vazio.' };
  if (buffer.length > LIMITE_BYTES) return { ok: false, motivo: 'Arquivo acima de 16 MB.' };

  const id = 'ANX-' + crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 24);
  const meta = {
    id,
    nome: nomeSeguro(nome),
    tipo: tipoSeguro(tipo),
    tamanho: buffer.length,
    em: new Date().toISOString(),
  };

  fs.mkdirSync(DIR, { recursive: true });
  const c = caminhos(id);
  // Escrita atômica: um .bin pela metade seria enviado como imagem quebrada.
  fs.writeFileSync(`${c.bin}.tmp`, buffer);
  fs.renameSync(`${c.bin}.tmp`, c.bin);
  fs.writeFileSync(`${c.meta}.tmp`, JSON.stringify(meta));
  fs.renameSync(`${c.meta}.tmp`, c.meta);

  limparVencidos();
  return { ok: true, anexo: meta };
}

/** Devolve { id, nome, tipo, tamanho, buffer } ou null se não existir mais. */
function ler(id) {
  const chave = String(id || '');
  if (!RE_ID.test(chave)) return null;
  const c = caminhos(chave);
  try {
    const meta = JSON.parse(fs.readFileSync(c.meta, 'utf8'));
    const buffer = fs.readFileSync(c.bin);
    // Renova a validade: lote em andamento não pode perder o arquivo no meio.
    const agora = new Date();
    fs.utimesSync(c.meta, agora, agora);
    fs.utimesSync(c.bin, agora, agora);
    return { ...meta, buffer };
  } catch (_) {
    return null;
  }
}

limparVencidos();

module.exports = { salvar, ler, LIMITE_BYTES };
