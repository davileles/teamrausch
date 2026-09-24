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

/* --------------------------- diagnóstico -------------------------------- */
// Tudo o que ajuda a entender uma falha sem abrir o log do Railway: aparece
// em GET /status. Nenhum dado de aluno entra aqui.
const ESPERA_CONEXAO_MS = Number(process.env.ESPERA_CONEXAO_MS || 5000);
const ENVIO_TIMEOUT_MS = Number(process.env.ENVIO_TIMEOUT_MS || 25000);
const ENVIO_TIMEOUT_ANEXO_MS = Number(process.env.ENVIO_TIMEOUT_ANEXO_MS || 85000);
const iniciadoEm = new Date().toISOString();
let situacaoDesde = Date.now();
let conectadoEm = null;
let ultimaQueda = null;          // { em, codigo, motivo }
let reconexoes = 0;
let timerReconexao = null;
let encerrando = false;
let errosSoltos = 0;
let ultimoErro = null;           // { em, tipo, mensagem }
const errosRecentes = [];        // timestamps, para detectar rajada
const envios = { ok: 0, falhas: 0, ultimoOk: null, ultimaFalha: null };

function mudarSituacao(nova) {
  if (situacao !== nova) situacaoDesde = Date.now();
  situacao = nova;
}

/** Nome legível do código de queda do Baileys (401 → loggedOut etc.). */
function nomeDaQueda(codigo) {
  if (!codigo) return 'sem código';
  const nome = Object.keys(DisconnectReason).find((k) => DisconnectReason[k] === codigo);
  return nome ? `${nome} (${codigo})` : `código ${codigo}`;
}

function anotarFalhaDeEnvio(fase, mensagem) {
  envios.falhas += 1;
  envios.ultimaFalha = { em: new Date().toISOString(), fase, mensagem: String(mensagem || '').slice(0, 200) };
}

/* ------------------------- reenvio (retry) ------------------------------ */
// Quando o celular do destinatário não consegue decifrar a mensagem, ele pede
// ao remetente para mandar de novo. O Baileys só atende se `getMessage`
// devolver a mensagem original — sem isso ela fica em "Aguardando mensagem".
// Guardamos as enviadas em memória por 24h (máx. 1000).
const ENVIADAS_TTL = 24 * 60 * 60 * 1000;
const ENVIADAS_MAX = 1000;
const enviadas = new Map(); // key.id -> { message, em }

function guardarEnviada(r) {
  if (!r || !r.key || !r.key.id || !r.message) return;
  enviadas.set(r.key.id, { message: r.message, em: Date.now() });
  while (enviadas.size > ENVIADAS_MAX) enviadas.delete(enviadas.keys().next().value);
}

async function buscarEnviada(key) {
  const id = key && key.id;
  const para = key && key.remoteJid;
  const item = id && enviadas.get(id);
  if (!item) { log('[retry] pedido de reenvio SEM mensagem guardada', id, para); return undefined; }
  if (Date.now() - item.em > ENVIADAS_TTL) {
    enviadas.delete(id);
    log('[retry] pedido de reenvio de mensagem vencida', id, para);
    return undefined;
  }
  log('[retry] reenviando a pedido do destinatário', id, para);
  return item.message;
}

// Cache mínimo com a interface que o Baileys usa (get/set/del/flushAll).
const contadorRetry = new Map();
const msgRetryCounterCache = {
  get: (k) => contadorRetry.get(k),
  set: (k, v) => { contadorRetry.set(k, v); if (contadorRetry.size > 5000) contadorRetry.delete(contadorRetry.keys().next().value); return true; },
  del: (k) => contadorRetry.delete(k),
  flushAll: () => contadorRetry.clear(),
};

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

function gravarContatosAgora() {
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
}

function gravarContatos() {
  if (gravacaoNomes) return;
  gravacaoNomes = setTimeout(() => {
    gravacaoNomes = null;
    gravarContatosAgora();
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

/** Fecha o socket atual SEM deslogar. Tira os ouvintes antes para o 'close' não agendar outra reconexão. */
function fecharSocket() {
  if (!socket) return;
  const velho = socket;
  socket = null;
  try { velho.ev.removeAllListeners(); } catch (_) { /* nada */ }
  try { velho.end(undefined); } catch (_) { /* nada */ }
}

/** Uma reconexão agendada por vez: timers duplicados abriam dois sockets na mesma sessão. */
function agendarReconexao(espera) {
  if (encerrando) return;
  if (timerReconexao) clearTimeout(timerReconexao);
  timerReconexao = setTimeout(() => {
    timerReconexao = null;
    conectar().catch((e) => {
      log('falha ao reconectar:', e.message);
      tentativas += 1;
      agendarReconexao(Math.min(60000, 2000 * tentativas));
    });
  }, espera);
}

async function conectar() {
  if (encerrando) return;
  if (timerReconexao) { clearTimeout(timerReconexao); timerReconexao = null; }
  fecharSocket();
  fs.mkdirSync(PASTA_SESSAO, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(PASTA_SESSAO);
  const { version } = await fetchLatestBaileysVersion();

  const meu = makeWASocket({
    version,
    auth: state,
    logger: registro,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    getMessage: buscarEnviada,
    msgRetryCounterCache,
  });
  socket = meu;

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

    if (meu !== socket) return; // evento atrasado de um socket já descartado

    if (qr) {
      qrAtual = qr;
      mudarSituacao('aguardando-qr');
      log('QR novo disponível em /qr');
    }

    if (connection === 'open') {
      qrAtual = null;
      mudarSituacao('conectado');
      if (conectadoEm) reconexoes += 1;
      conectadoEm = new Date().toISOString();
      tentativas = 0;
      numeroConectado = (socket.user && socket.user.id || '').split(':')[0] || null;
      log('conectado como', numeroConectado);
    }

    if (connection === 'close') {
      const motivo = lastDisconnect && lastDisconnect.error
        && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;

      ultimaQueda = {
        em: new Date().toISOString(),
        codigo: motivo || null,
        motivo: nomeDaQueda(motivo),
        detalhe: String((lastDisconnect && lastDisconnect.error && lastDisconnect.error.message) || '').slice(0, 200),
      };
      mudarSituacao('desconectado');

      if (motivo === DisconnectReason.loggedOut) {
        // A sessão não volta mais. Guardamos uma cópia (para diagnóstico) e
        // subimos limpo: o QR novo aparece em Configurações → Técnica.
        log('sessão encerrada no celular (loggedOut). Arquivando a sessão e gerando QR novo.');
        try {
          const arquivo = path.join(PASTA, 'sessao-encerrada');
          fs.rmSync(arquivo, { recursive: true, force: true });
          if (fs.existsSync(PASTA_SESSAO)) fs.renameSync(PASTA_SESSAO, arquivo);
        } catch (e) {
          log('não consegui arquivar a sessão:', e.message);
        }
        numeroConectado = null;
        agendarReconexao(3000);
        return;
      }

      if (motivo === DisconnectReason.connectionReplaced) {
        log('conexão substituída (440): outra instância abriu esta mesma sessão. '
          + 'Confira RAILWAY_DEPLOYMENT_OVERLAP_SECONDS=0 no serviço.');
      }

      tentativas += 1;
      const espera = motivo === DisconnectReason.restartRequired
        ? 1000
        : Math.min(60000, 2000 * tentativas);
      log(`conexão caiu (${ultimaQueda.motivo}). Tentando de novo em ${espera / 1000}s`);
      agendarReconexao(espera);
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

  let falhas = 0;
  for (const numero of opcoes) {
    try {
      const achados = await socket.onWhatsApp(numero);
      const bom = (achados || []).find((r) => r.exists);
      if (bom) return bom.jid;
    } catch (e) {
      falhas += 1;
      log('onWhatsApp falhou para', numero, '-', e.message);
    }
  }
  // Se TODAS as consultas deram erro, não sabemos se o número tem WhatsApp:
  // é problema de conexão, e pode repetir. Antes isso virava
  // "Esse número não tem WhatsApp", o que mandava procurar o erro no lugar errado.
  if (falhas === opcoes.length) {
    const e = new Error('Não consegui consultar o número no WhatsApp (conexão instável).');
    e.fase = 'consulta';
    throw e;
  }
  return null;
}

/** Espera o WhatsApp voltar por até `ms` — cobre a reconexão rápida depois de uma queda. */
async function esperarConexao(ms) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    if (situacao === 'conectado' && socket) return true;
    if (encerrando) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
  return situacao === 'conectado' && Boolean(socket);
}

/** Promise com prazo. Sem isso, um sendMessage travado segurava a fila inteira para sempre. */
function comPrazo(promessa, ms, fase) {
  let timer;
  const prazo = new Promise((_, rejeitar) => {
    timer = setTimeout(() => {
      const e = new Error(`O WhatsApp não confirmou o envio em ${Math.round(ms / 1000)}s.`);
      e.fase = fase;
      rejeitar(e);
    }, ms);
  });
  return Promise.race([promessa, prazo]).finally(() => clearTimeout(timer));
}

/* ------------------------------ rotas ----------------------------------- */

const app = express();

/**
 * O limite de 128 KB continua valendo para tudo, menos para POST /enviar: é
 * por ali que chega o anexo (em base64), e um parser global maior abriria
 * todas as rotas para corpos de 20 MB. /enviar ganha o parser próprio abaixo,
 * que só roda DEPOIS de conferir o token.
 */
const jsonPequeno = express.json({ limit: '128kb' });
app.use((req, res, next) => (req.method === 'POST' && req.path === '/enviar' ? next() : jsonPequeno(req, res, next)));

const LIMITE_ANEXO_BYTES = 16 * 1024 * 1024;
const jsonComAnexo = express.json({ limit: '24mb' });
function lerCorpoComAnexo(req, res, next) {
  jsonComAnexo(req, res, (erro) => {
    if (!erro) return next();
    if (erro.type === 'entity.too.large') return res.status(413).json({ erro: 'Anexo acima de 16 MB.' });
    return res.status(400).json({ erro: 'Corpo inválido.' });
  });
}

/**
 * Anexo chega como { base64, mimetype, nome }. Imagem e vídeo mp4 saem como
 * mídia (aparecem na conversa com a legenda); o resto sai como documento, que
 * o WhatsApp abre com o nome original do arquivo.
 */
const TIPOS_IMAGEM = ['image/jpeg', 'image/png', 'image/webp'];
function montarConteudo(mensagem, anexo) {
  if (!anexo) return { ok: true, conteudo: { text: mensagem } };

  const base64 = String(anexo.base64 || '').replace(/^data:[^;]+;base64,/, '');
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) return { ok: false, motivo: 'Anexo vazio ou ilegível.' };
  if (buffer.length > LIMITE_ANEXO_BYTES) return { ok: false, motivo: 'Anexo acima de 16 MB.' };

  const mimetype = String(anexo.mimetype || 'application/octet-stream').toLowerCase();
  const nome = String(anexo.nome || 'arquivo').slice(0, 120);
  const legenda = mensagem ? { caption: mensagem } : {};

  if (TIPOS_IMAGEM.includes(mimetype)) return { ok: true, conteudo: { image: buffer, mimetype, ...legenda } };
  if (mimetype === 'video/mp4') return { ok: true, conteudo: { video: buffer, mimetype, ...legenda } };
  return { ok: true, conteudo: { document: buffer, mimetype, fileName: nome, ...legenda } };
}

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
    // diagnóstico
    situacaoHaS: Math.round((Date.now() - situacaoDesde) / 1000),
    iniciadoEm,
    ativoHaS: Math.round(process.uptime()),
    conectadoEm,
    reconexoes,
    ultimaQueda,
    errosSoltos,
    ultimoErro,
    envios,
    memoriaMb: Math.round(process.memoryUsage().rss / 1048576),
  });
});

/** Só diz se o processo está vivo. Serve de healthcheck: não depende do WhatsApp estar conectado. */
app.get('/health', (_req, res) => res.json({ vivo: true, situacao }));

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

/*
 * CONTRATO DE ERRO DO /enviar
 *   Todo erro volta { erro, fase, podeRepetir }.
 *   podeRepetir=true  → nada saiu; o app pode tentar de novo com segurança.
 *   podeRepetir=false → ou o pedido é inválido, ou o envio é AMBÍGUO (pode ter
 *                       saído): repetir arriscaria mandar duas vezes ao aluno.
 */
app.post('/enviar', exigirToken, lerCorpoComAnexo, async (req, res) => {
  if (encerrando) {
    return res.status(503).json({ erro: 'Serviço de WhatsApp reiniciando.', fase: 'conexao', podeRepetir: true });
  }
  if (situacao !== 'conectado' && !(await esperarConexao(ESPERA_CONEXAO_MS))) {
    anotarFalhaDeEnvio('conexao', `WhatsApp ${situacao}`);
    const dica = situacao === 'aguardando-qr' ? ' Leia o QR em Configurações → Técnica.' : '';
    return res.status(503).json({
      erro: `WhatsApp desconectado (${situacao}).${dica}`,
      fase: 'conexao',
      podeRepetir: true,
    });
  }

  // `destino` e o nome novo, que aceita telefone OU JID de grupo. `telefone`
  // continua valendo para nao quebrar quem ja chama esta rota.
  const bruto = String(req.body.destino || req.body.telefone || '').trim();
  const ehGrupo = RE_JID_GRUPO.test(bruto);
  const telefone = ehGrupo ? null : normalizar(bruto);
  const mensagem = String(req.body.mensagem || '').trim();
  const anexo = req.body.anexo && typeof req.body.anexo === 'object' ? req.body.anexo : null;
  if (!ehGrupo && !telefone) {
    return res.status(400).json({ erro: 'Destino inválido. Use telefone com DDD ou um JID de grupo (…@g.us).', fase: 'validacao', podeRepetir: false });
  }
  // Com anexo a legenda é opcional: uma imagem sozinha já é a mensagem.
  if (!mensagem && !anexo) return res.status(400).json({ erro: 'Mensagem vazia.', fase: 'validacao', podeRepetir: false });

  const montado = montarConteudo(mensagem, anexo);
  if (!montado.ok) return res.status(400).json({ erro: montado.motivo, fase: 'validacao', podeRepetir: false });

  const alvo = ehGrupo ? bruto : telefone;
  try {
    const resultado = await enfileirar(async () => {
      // Pode ter caído enquanto esperava na fila.
      if (situacao !== 'conectado' || !socket) {
        const e = new Error(`WhatsApp caiu antes do envio (${situacao}).`);
        e.fase = 'conexao';
        throw e;
      }
      // Grupo ja e o proprio endereco; so telefone precisa da consulta do
      // nono dígito.
      const jid = ehGrupo ? bruto : await comPrazo(descobrirJid(telefone), 15000, 'consulta');
      if (!jid) return { ok: false, motivo: 'Esse número não tem WhatsApp.' };
      const r = await comPrazo(
        socket.sendMessage(jid, montado.conteudo),
        anexo ? ENVIO_TIMEOUT_ANEXO_MS : ENVIO_TIMEOUT_MS,
        'envio',
      );
      guardarEnviada(r);
      log('[envio]', r && r.key && r.key.id, '→', jid);
      return { ok: true, id: r && r.key && r.key.id, jid };
    });

    if (!resultado.ok) {
      anotarFalhaDeEnvio('destino', resultado.motivo);
      return res.status(404).json({ erro: resultado.motivo, fase: 'destino', podeRepetir: false });
    }
    envios.ok += 1;
    envios.ultimoOk = new Date().toISOString();
    log('enviado para', alvo, anexo ? `(com anexo ${anexo.mimetype || '?'})` : '');
    res.json({ enviado: true, id: resultado.id });
  } catch (erro) {
    const fase = erro.fase || 'envio';
    // conexão/consulta: nada saiu. envio: pode ter saído — não repetir.
    const seguro = fase === 'conexao' || fase === 'consulta';
    log(`falha no envio para ${alvo} [${fase}]:`, erro.message);
    anotarFalhaDeEnvio(fase, erro.message);
    res.status(seguro ? 503 : 502).json({
      erro: seguro ? erro.message : `Não consegui confirmar o envio: ${erro.message}`,
      fase,
      podeRepetir: seguro,
    });
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

/* ------------------------- proteção do processo -------------------------- */

/**
 * Erro solto dentro do Baileys (acontece) matava o Node inteiro: o Railway
 * ficava sem nada escutando até reiniciar, e o app recebia o 503 genérico do
 * proxy ("upstream connect error ... connection termination"). Agora o erro é
 * registrado e o processo segue. Só se vier uma rajada (algo realmente
 * quebrado) é que saímos, para o Railway subir um processo limpo.
 */
function anotarErroSolto(tipo, erro) {
  errosSoltos += 1;
  const mensagem = String((erro && (erro.stack || erro.message)) || erro).slice(0, 500);
  ultimoErro = { em: new Date().toISOString(), tipo, mensagem: mensagem.split('\n')[0] };
  log(`[${tipo}]`, mensagem);
  const agora = Date.now();
  errosRecentes.push(agora);
  while (errosRecentes.length && agora - errosRecentes[0] > 60000) errosRecentes.shift();
  if (errosRecentes.length >= 20) {
    log('20 erros soltos em 1 minuto: saindo para o Railway reiniciar limpo.');
    encerrar('rajada-de-erros', 1);
  }
}
process.on('unhandledRejection', (motivo) => anotarErroSolto('unhandledRejection', motivo));
process.on('uncaughtException', (erro) => anotarErroSolto('uncaughtException', erro));

/**
 * Vigia: se ficou desconectado sem reconexão agendada (timer perdido, erro
 * no meio do caminho), religa. Não mexe em quem está esperando QR.
 */
const vigia = setInterval(() => {
  if (encerrando || timerReconexao) return;
  const parado = Date.now() - situacaoDesde;
  if ((situacao === 'desconectado' || situacao === 'iniciando') && parado > 120000) {
    log(`vigia: ${situacao} há ${Math.round(parado / 1000)}s sem reconexão agendada. Religando.`);
    agendarReconexao(0);
  }
}, 60000);
if (vigia.unref) vigia.unref();

/**
 * Deploy/restart do Railway manda SIGTERM. Fechar o socket com calma (sem
 * logout) e gravar o caderno evita sessão corrompida e QR pedido à toa.
 */
let servidor = null;
function encerrar(sinal, codigoSaida = 0) {
  if (encerrando) return;
  encerrando = true;
  log(`${sinal}: fechando a conexão do WhatsApp (sem deslogar).`);
  if (timerReconexao) clearTimeout(timerReconexao);
  if (gravacaoNomes) { clearTimeout(gravacaoNomes); gravacaoNomes = null; }
  gravarContatosAgora();
  fecharSocket();
  if (servidor) servidor.close();
  setTimeout(() => process.exit(codigoSaida), 3000).unref();
}
process.on('SIGTERM', () => encerrar('SIGTERM'));
process.on('SIGINT', () => encerrar('SIGINT'));

servidor = app.listen(PORTA, () => log(`WhatsApp do estúdio na porta ${PORTA}`));
conectar().catch((e) => {
  log('falha ao iniciar:', e.message);
  agendarReconexao(5000);
});
