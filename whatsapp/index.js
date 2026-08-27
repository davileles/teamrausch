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

/* --------------------------- caderno de nomes ---------------------------- */
/**
 * O WhatsApp NÃO entrega o nome dos participantes junto com o grupo:
 * `groupMetadata` devolve só os números. O nome chega por três caminhos, e
 * nenhum deles é garantido:
 *
 *   1. sincronização da agenda no pareamento (`messaging-history.set`) — só
 *      traz quem está salvo na agenda do celular que leu o QR;
 *   2. `contacts.upsert` / `contacts.update`, ao longo do uso;
 *   3. `pushName` da mensagem — o nome que a própria pessoa pôs no perfil dela,
 *      e que só aparece quando ela escreve em algum grupo que este número vê.
 *
 * Por isso tudo o que passa é anotado aqui e gravado em disco: a janela de
 * captura não volta. O que não for guardado na hora se perde na reconexão.
 */
const ARQUIVO_CONTATOS = path.join(PASTA, 'contatos.json');
const nomes = new Map();   // '5511999999999' -> { agenda, perfil, em }
let gravacaoNomes = null;

function soNumero(entrada) {
  const n = String(entrada || '').split('@')[0].split(':')[0].replace(/\D/g, '');
  return n || null;
}

function carregarContatos() {
  try {
    fs.mkdirSync(PASTA, { recursive: true });
    if (!fs.existsSync(ARQUIVO_CONTATOS)) return;
    const lido = JSON.parse(fs.readFileSync(ARQUIVO_CONTATOS, 'utf8'));
    for (const [numero, dados] of Object.entries(lido.contatos || {})) nomes.set(numero, dados);
    log(`${nomes.size} nome(s) no caderno`);
  } catch (erro) {
    log('não consegui ler o caderno de nomes:', erro.message);
  }
}

function gravarContatos() {
  if (gravacaoNomes) return;
  gravacaoNomes = setTimeout(() => {
    gravacaoNomes = null;
    try {
      fs.mkdirSync(PASTA, { recursive: true });
      const corpo = JSON.stringify({
        atualizadoEm: new Date().toISOString(),
        total: nomes.size,
        contatos: Object.fromEntries(nomes),
      }, null, 2);
      const temp = `${ARQUIVO_CONTATOS}.tmp`;
      fs.writeFileSync(temp, corpo);
      fs.renameSync(temp, ARQUIVO_CONTATOS);
    } catch (erro) {
      log('falha ao gravar o caderno de nomes:', erro.message);
    }
  }, 3000);
  if (gravacaoNomes.unref) gravacaoNomes.unref();
}

/** Nome novo nunca apaga nome antigo: só preenche o que ainda está vazio ou mudou. */
function anotarNome(jid, { agenda, perfil } = {}) {
  const numero = soNumero(jid);
  if (!numero || (!agenda && !perfil)) return;
  const atual = nomes.get(numero) || {};
  const limpo = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const novoAgenda = limpo(agenda) || atual.agenda || null;
  const novoPerfil = limpo(perfil) || atual.perfil || null;
  if (novoAgenda === (atual.agenda || null) && novoPerfil === (atual.perfil || null)) return;
  nomes.set(numero, { agenda: novoAgenda, perfil: novoPerfil, em: new Date().toISOString() });
  gravarContatos();
}

/**
 * Grupo criado depois da mudança do WhatsApp para LID pode devolver o
 * participante como `...@lid`, que é um identificador interno e não o telefone.
 * Quando isso acontece e o servidor não manda o número junto, não há telefone
 * para extrair — a linha sai marcada como oculta em vez de sair com lixo.
 */
function telefoneDoParticipante(p) {
  const bruto = p.phoneNumber || p.jid || p.id || '';
  if (String(bruto).endsWith('@lid')) return null;
  return soNumero(bruto);
}

carregarContatos();

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

  // Sincronização inicial: é aqui que a agenda do celular pareado aparece, uma
  // única vez por pareamento. Se este bloco não guardar, não tem segunda chance.
  socket.ev.on('messaging-history.set', ({ contacts }) => {
    for (const contato of contacts || []) {
      anotarNome(contato.id, { agenda: contato.name, perfil: contato.notify || contato.verifiedName });
    }
  });

  const daAgenda = (lista) => {
    for (const contato of lista || []) {
      anotarNome(contato.id, { agenda: contato.name, perfil: contato.notify || contato.verifiedName });
    }
  };
  socket.ev.on('contacts.upsert', daAgenda);
  socket.ev.on('contacts.update', daAgenda);

  // pushName: o nome do perfil de quem escreveu. Vale para gente que não está
  // na agenda — em grupo grande é o que mais rende.
  socket.ev.on('messages.upsert', ({ messages }) => {
    for (const msg of messages || []) {
      const autor = msg.key?.participant || msg.key?.remoteJid;
      if (!msg.key?.fromMe && autor) anotarNome(autor, { perfil: msg.pushName });
    }
  });

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
 * JID de grupo do WhatsApp. Serve para o mesmo POST /enviar atender pessoa e
 * grupo: o painel manda o grupo do operador aqui, e o grupo nao passa por
 * `normalizar` — os digitos de um JID de grupo nao sao um telefone.
 */
const RE_JID_GRUPO = /^\d{5,}@g\.us$/;

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

/**
 * Mesmo QR, em JSON, para a tela de Configurações do app de agendamento
 * desenhar sem abrir uma página deste serviço. Devolve a imagem já pronta em
 * data URL: o painel só precisa jogar num <img>.
 */
app.get('/qr.json', exigirToken, async (_req, res) => {
  let imagem = null;
  if (qrAtual && situacao !== 'conectado') {
    imagem = await QRCode.toDataURL(qrAtual, { margin: 1, width: 320 }).catch(() => null);
  }
  res.json({
    situacao,
    numero: numeroConectado,
    temQr: Boolean(qrAtual),
    imagem,
  });
});

/** Lista os grupos de que ESTE número participa. */
app.get('/grupos', exigirToken, async (_req, res) => {
  if (situacao !== 'conectado') {
    return res.status(503).json({ erro: 'WhatsApp desconectado. Leia o QR em /qr.' });
  }
  try {
    const todos = await socket.groupFetchAllParticipating();
    const grupos = Object.values(todos)
      .map((g) => ({
        id: g.id,
        nome: g.subject || '(sem nome)',
        participantes: (g.participants || []).length,
      }))
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    res.json({ total: grupos.length, grupos });
  } catch (erro) {
    log('falha ao listar grupos:', erro.message);
    res.status(502).json({ erro: 'Não consegui listar os grupos.' });
  }
});

/**
 * Participantes de um grupo, com o nome que tivermos no caderno.
 *
 * `?formato=csv` devolve planilha pronta (com BOM, senão o Excel come os
 * acentos). O campo `nome` fica em branco para quem nunca escreveu no grupo e
 * não está na agenda — isso é limitação do WhatsApp, não do serviço.
 */
app.get('/grupos/participantes', exigirToken, async (req, res) => {
  if (situacao !== 'conectado') {
    return res.status(503).json({ erro: 'WhatsApp desconectado. Leia o QR em /qr.' });
  }
  const id = String(req.query.id || '').trim();
  if (!id.endsWith('@g.us')) {
    return res.status(400).json({ erro: 'Informe ?id=<jid do grupo>, terminado em @g.us.' });
  }

  try {
    const meta = await socket.groupMetadata(id);
    const participantes = (meta.participants || []).map((p) => {
      const telefone = telefoneDoParticipante(p);
      const anotado = (telefone && nomes.get(telefone)) || {};
      return {
        telefone,
        oculto: !telefone,
        nome: anotado.agenda || anotado.perfil || null,
        nomeAgenda: anotado.agenda || null,
        nomePerfil: anotado.perfil || null,
        admin: p.admin || null,
      };
    });

    const comNome = participantes.filter((p) => p.nome).length;

    if (String(req.query.formato || '').toLowerCase() === 'csv') {
      const escapar = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const linhas = [['telefone', 'nome', 'nome_agenda', 'nome_perfil', 'admin'].join(';')];
      for (const p of participantes) {
        linhas.push([p.telefone, p.nome, p.nomeAgenda, p.nomePerfil, p.admin].map(escapar).join(';'));
      }
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', 'attachment; filename="participantes.csv"');
      return res.send('\uFEFF' + linhas.join('\n'));
    }

    res.json({
      grupo: meta.subject || '(sem nome)',
      id: meta.id,
      total: participantes.length,
      comNome,
      semNome: participantes.length - comNome,
      participantes,
    });
  } catch (erro) {
    log('falha ao ler participantes:', erro.message);
    res.status(502).json({ erro: 'Não consegui ler os participantes desse grupo.' });
  }
});

/** Quantos nomes já foram capturados até agora. Serve para saber se vale exportar. */
app.get('/contatos', exigirToken, (_req, res) => {
  const lista = [...nomes.entries()].map(([telefone, d]) => ({ telefone, ...d }));
  res.json({ total: lista.length, contatos: lista });
});

app.post('/enviar', exigirToken, async (req, res) => {
  if (situacao !== 'conectado') {
    return res.status(503).json({ erro: 'WhatsApp desconectado. Leia o QR em /qr.' });
  }

  // `destino` e o nome novo, que aceita telefone OU JID de grupo. `telefone`
  // continua valendo para nao quebrar quem ja chama esta rota.
  const bruto = String(req.body.destino || req.body.telefone || '').trim();
  const ehGrupo = RE_JID_GRUPO.test(bruto);
  const telefone = ehGrupo ? null : normalizar(bruto);
  const mensagem = String(req.body.mensagem || '').trim();
  if (!ehGrupo && !telefone) {
    return res.status(400).json({ erro: 'Destino inválido. Use telefone com DDD ou um JID de grupo (…@g.us).' });
  }
  if (!mensagem) return res.status(400).json({ erro: 'Mensagem vazia.' });

  const alvo = ehGrupo ? bruto : telefone;
  try {
    const resultado = await enfileirar(async () => {
      // Grupo ja e o proprio endereco; so telefone precisa da consulta do
      // nono dígito.
      const jid = ehGrupo ? bruto : await descobrirJid(telefone);
      if (!jid) return { ok: false, motivo: 'Esse número não tem WhatsApp.' };
      const r = await socket.sendMessage(jid, { text: mensagem });
      return { ok: true, id: r && r.key && r.key.id, jid };
    });

    if (!resultado.ok) return res.status(404).json({ erro: resultado.motivo });
    log('enviado para', alvo);
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
