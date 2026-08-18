'use strict';

/**
 * Serviço de WhatsApp dedicado ao estúdio.
 *
 * Roda separado do app de agendamento e de qualquer outro Baileys que você já
 * tenha. Sessão própria, número próprio, volume próprio. Se este cair ou o
 * número for bloqueado, nada mais é afetado.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} = require('baileys');

const PORTA = process.env.PORT || 3000;
const TOKEN = process.env.WHATSAPP_TOKEN || '';
const PASTA = process.env.DATA_DIR || path.join(__dirname, 'data');
const PASTA_SESSAO = path.join(PASTA, 'sessao');
const PAUSA_ENTRE_ENVIOS = Number(process.env.PAUSA_ENTRE_ENVIOS_MS || 1200);

const registro = pino({ level: process.env.LOG_LEVEL || 'silent' });
function log(...a) { console.log(new Date().toISOString(), ...a); }

let socket = null;
let qrAtual = null;
let situacao = 'iniciando'; // iniciando | aguardando-qr | conectado | desconectado
let numeroConectado = null;
let tentativas = 0;

/* ----------------------------- conexão ---------------------------------- */

async function conectar() {
  fs.mkdirSync(PASTA_SESSAO, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(PASTA_SESSAO);
  const { version } = await fetchLatestBaileysVersion();

  socket = makeWASocket({
    version,
    auth: state,
    logger: registro,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
  });

  socket.ev.on('creds.update', saveCreds);

  socket.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      qrAtual = qr;
      situacao = 'aguardando-qr';
      log('QR novo disponível em /qr');
    }

    if (connection === 'open') {
      qrAtual = null;
      situacao = 'conectado';
      tentativas = 0;
      numeroConectado = (socket.user && socket.user.id || '').split(':')[0] || null;
      log('conectado como', numeroConectado);
    }

    if (connection === 'close') {
      const motivo = lastDisconnect && lastDisconnect.error
        && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;

      if (motivo === DisconnectReason.loggedOut) {
        situacao = 'desconectado';
        log('sessão encerrada no celular. Apague a pasta da sessão e leia o QR de novo.');
        return;
      }

      situacao = 'desconectado';
      tentativas += 1;
      const espera = Math.min(60000, 2000 * tentativas);
      log(`conexão caiu (${motivo}). Tentando de novo em ${espera / 1000}s`);
      setTimeout(() => conectar().catch((e) => log('falha ao reconectar:', e.message)), espera);
    }
  });
}

/* ------------------------------ fila ------------------------------------ */
// Uma mensagem por vez, com pausa: disparo em rajada é o que costuma
// derrubar número no WhatsApp.

const fila = [];
let rodando = false;

function enfileirar(tarefa) {
  return new Promise((resolve, reject) => {
    fila.push({ tarefa, resolve, reject });
    girar();
  });
}

async function girar() {
  if (rodando || !fila.length) return;
  rodando = true;
  const { tarefa, resolve, reject } = fila.shift();
  try { resolve(await tarefa()); } catch (e) { reject(e); }
  setTimeout(() => { rodando = false; girar(); }, PAUSA_ENTRE_ENVIOS);
}

/* ------------------------------ envio ----------------------------------- */

function normalizar(entrada) {
  let n = String(entrada || '').replace(/\D/g, '');
  if (!n.startsWith('55')) n = '55' + n;
  return n.length === 12 || n.length === 13 ? n : null;
}

/**
 * Celular brasileiro tem duas formas possíveis no WhatsApp: com e sem o nono
 * dígito. Perguntamos ao servidor qual existe antes de mandar.
 */
async function descobrirJid(telefone) {
  const ddd = telefone.slice(2, 4);
  const resto = telefone.slice(4);
  const opcoes = resto.length === 9
    ? [telefone, `55${ddd}${resto.slice(1)}`]
    : [`55${ddd}9${resto}`, telefone];

  for (const numero of opcoes) {
    try {
      const achados = await socket.onWhatsApp(numero);
      const bom = (achados || []).find((r) => r.exists);
      if (bom) return bom.jid;
    } catch (e) {
      log('onWhatsApp falhou para', numero, '-', e.message);
    }
  }
  return null;
}

/* ------------------------------ rotas ----------------------------------- */

const app = express();
app.use(express.json({ limit: '128kb' }));

function exigirToken(req, res, next) {
  if (!TOKEN) return next();
  const cabecalho = req.get('Authorization') || req.get('X-Token') || '';
  if (cabecalho.replace(/^Bearer /i, '').trim() === TOKEN) return next();
  return res.status(401).json({ erro: 'Token inválido.' });
}

app.get('/status', (_req, res) => {
  res.json({
    situacao,
    numero: numeroConectado,
    temQr: Boolean(qrAtual),
    naFila: fila.length,
  });
});

/** Página para ler o QR pelo navegador, sem depender do log do Railway. */
app.get('/qr', exigirToken, async (_req, res) => {
  if (situacao === 'conectado') {
    return res.send(pagina('Conectado', `Este serviço está ligado ao número ${numeroConectado}.`));
  }
  if (!qrAtual) {
    return res.send(pagina('Sem QR agora', 'Aguarde alguns segundos e atualize a página.'));
  }
  const imagem = await QRCode.toDataURL(qrAtual, { margin: 1, width: 320 });
  res.send(pagina('Leia o QR', 'WhatsApp → Aparelhos conectados → Conectar aparelho.',
    `<img src="${imagem}" alt="QR de conexão" width="320" height="320">`));
});

app.post('/enviar', exigirToken, async (req, res) => {
  if (situacao !== 'conectado') {
    return res.status(503).json({ erro: 'WhatsApp desconectado. Leia o QR em /qr.' });
  }

  const telefone = normalizar(req.body.telefone);
  const mensagem = String(req.body.mensagem || '').trim();
  if (!telefone) return res.status(400).json({ erro: 'Telefone inválido.' });
  if (!mensagem) return res.status(400).json({ erro: 'Mensagem vazia.' });

  try {
    const resultado = await enfileirar(async () => {
      const jid = await descobrirJid(telefone);
      if (!jid) return { ok: false, motivo: 'Esse número não tem WhatsApp.' };
      const r = await socket.sendMessage(jid, { text: mensagem });
      return { ok: true, id: r && r.key && r.key.id, jid };
    });

    if (!resultado.ok) return res.status(404).json({ erro: resultado.motivo });
    log('enviado para', telefone);
    res.json({ enviado: true, id: resultado.id });
  } catch (erro) {
    log('falha no envio:', erro.message);
    res.status(502).json({ erro: 'Não consegui enviar a mensagem.' });
  }
});

function pagina(titulo, texto, extra = '') {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${titulo}</title>
<style>body{background:#E8E9E4;color:#101317;font:400 16px/1.5 system-ui,sans-serif;
display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
.c{text-align:center;max-width:380px}h1{font-size:21px;margin:0 0 8px}
p{color:#6E7580;font-size:14px;margin:0 0 20px}img{border:1px solid #D2D4CD;border-radius:4px;background:#fff;padding:10px}
</style></head><body><div class="c"><h1>${titulo}</h1><p>${texto}</p>${extra}</div></body></html>`;
}

app.listen(PORTA, () => log(`WhatsApp do estúdio na porta ${PORTA}`));
conectar().catch((e) => log('falha ao iniciar:', e.message));
