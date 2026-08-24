'use strict';

/**
 * POLLER DO PORTAL — teamrausch/app/src/poller-portal.js
 *
 * A cada N minutos: renova a sessão (refresh_token -> x_session) e consulta a
 * fila. Janela de validação do check-in é ~1h30, então 15 min dá folga.
 *
 * DOIS MODOS:
 *   aviso      (padrão) — só avisa que há gente na fila; você confirma no portal.
 *   automático — confirma sozinho os pendentes. Confirmar sem presença conferida
 *                é o cenário que a Wellhub fiscaliza; é escolha sua.
 *
 * O modo é PERSISTIDO em DATA_DIR/poller-portal.json e pode ser trocado em
 * tempo real pelos endpoints do server.js — sem redeploy e sem mexer no
 * Railway. A variável de ambiente POLLER_PORTAL_AUTO_CONFIRMAR só define o
 * valor inicial, enquanto o arquivo de estado não existir.
 *
 * CANAIS DE AVISO (usa os que estiverem configurados):
 *   - E-mail via Resend  (RESEND_API_KEY presente)
 *   - WhatsApp via Baileys (WHATSAPP_URL/envio.url presente)
 *
 * QUEM RECEBE: as listas de Configurações → Avisos de check-in
 * (config.avisos.emails e config.avisos.telefones). Aceitam mais de um
 * destinatário. Sem e-mail cadastrado, cai no WELLHUB_ALERTA_EMAIL; sem
 * telefone cadastrado, o canal WhatsApp simplesmente não dispara.
 *
 * VARIÁVEIS:
 *   POLLER_PORTAL_ATIVO=true
 *   POLLER_PORTAL_MINUTOS=15
 *   POLLER_PORTAL_AUTO_CONFIRMAR=false     (só o padrão inicial)
 *   WELLHUB_ALERTA_EMAIL=davileles@gmail.com
 *   RESEND_API_KEY / RESEND_FROM
 *   WHATSAPP_URL / WHATSAPP_TOKEN
 *   DATA_DIR=/data
 *   (+ as WELLHUB_PORTAL_* usadas por wellhub-portal.js)
 */

const fs = require('fs');
const path = require('path');
const portal = require('./wellhub-portal');
const config = require('./config');

const ATIVO = String(process.env.POLLER_PORTAL_ATIVO || 'false') === 'true';
const MINUTOS = Number(process.env.POLLER_PORTAL_MINUTOS || 15);
const AUTO_PADRAO = String(process.env.POLLER_PORTAL_AUTO_CONFIRMAR || 'false') === 'true';
const EMAIL_DESTINO = process.env.WELLHUB_ALERTA_EMAIL || 'davileles@gmail.com';
const EMAIL_FROM = process.env.RESEND_FROM || 'Wellhub Alertas <onboarding@resend.dev>';
const DATA_DIR = process.env.DATA_DIR || '/data';
const ARQ_ESTADO = path.join(DATA_DIR, 'poller-portal.json');

function log(...a) { console.log(new Date().toISOString(), '[poller-portal]', ...a); }

/* ------------------------------------------------------------------------- *
 *  ESTADO PERSISTIDO — sobrevive a restart e deploy
 * ------------------------------------------------------------------------- */

const estado = {
  autoConfirmar: AUTO_PADRAO,
  atualizadoEm: null,
  ultimoCiclo: null,   // relatório do último ciclo (memória, não persistido)
};

(function carregarEstado() {
  try {
    const bruto = JSON.parse(fs.readFileSync(ARQ_ESTADO, 'utf8'));
    if (typeof bruto.autoConfirmar === 'boolean') estado.autoConfirmar = bruto.autoConfirmar;
    estado.atualizadoEm = bruto.atualizadoEm || null;
    log(`estado lido do disco: auto-confirmar=${estado.autoConfirmar}`);
  } catch (e) {
    log(`sem estado no disco; usando o padrão do ambiente: auto-confirmar=${AUTO_PADRAO}`);
  }
})();

function gravarEstado() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ARQ_ESTADO, JSON.stringify({
      autoConfirmar: estado.autoConfirmar,
      atualizadoEm: estado.atualizadoEm,
    }, null, 2));
  } catch (e) {
    log('não consegui gravar o estado no volume:', e.message);
  }
}

function situacao() {
  return {
    ativo: ATIVO,
    autoConfirmar: estado.autoConfirmar,
    modo: estado.autoConfirmar ? 'automatico' : 'aviso',
    minutosDoCiclo: MINUTOS,
    padraoDoAmbiente: AUTO_PADRAO,
    atualizadoEm: estado.atualizadoEm,
    slug: portal.SLUG || null,
    emailAviso: EMAIL_DESTINO,
    avisoCheckinLigado: preferencias().checkinConfirmado !== false,
    emailsAviso: emailsDestino(),
    telefonesAviso: telefonesDestino(),
    ultimoCiclo: estado.ultimoCiclo,
  };
}

function definirAuto(valor, origem = 'api') {
  estado.autoConfirmar = Boolean(valor);
  estado.atualizadoEm = new Date().toISOString();
  gravarEstado();
  log(`auto-confirmar = ${estado.autoConfirmar} (via ${origem})`);
  return situacao();
}

/* ------------------------------------------------------------------------- *
 *  AVISOS
 * ------------------------------------------------------------------------- */

/** Bloco `avisos` do config.json, com tolerância a config antigo. */
function preferencias() {
  try { return config.ler().avisos || {}; } catch (e) { return {}; }
}

/** Destinatários de e-mail. Sem lista cadastrada, cai no e-mail do ambiente. */
function emailsDestino() {
  const lista = (preferencias().emails || [])
    .map((e) => String(e || '').trim())
    .filter(Boolean);
  if (lista.length) return lista;
  return EMAIL_DESTINO ? [EMAIL_DESTINO] : [];
}

/** Destinatários de WhatsApp em E.164. Lista vazia = canal desligado. */
function telefonesDestino() {
  return (preferencias().telefones || [])
    .map((t) => String(t || '').replace(/\D/g, ''))
    .filter(Boolean);
}

/** Endereço e token do serviço de WhatsApp: config primeiro, ambiente depois. */
function canalWhatsApp() {
  let url = '';
  let token = '';
  try {
    const c = config.ler();
    url = (c.envio && c.envio.url) || '';
    token = (c.envio && c.envio.token) || '';
  } catch (e) { /* usa o ambiente abaixo */ }
  return {
    url: url || process.env.WHATSAPP_URL || '',
    token: token || process.env.WHATSAPP_TOKEN || '',
  };
}

async function enviarEmail(assunto, texto) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { log('RESEND_API_KEY ausente; e-mail não enviado.'); return; }
  const destinos = emailsDestino();
  if (!destinos.length) { log('nenhum e-mail cadastrado; e-mail não enviado.'); return; }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'authorization': `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: EMAIL_FROM, to: destinos, subject: assunto, text: texto }),
    });
    if (!r.ok) {
      const t = (await r.text().catch(() => '')).slice(0, 200);
      log('e-mail recusado:', r.status, t);
    } else {
      log('e-mail enviado para', destinos.join(', '));
    }
  } catch (e) { log('falha ao enviar e-mail:', e.message); }
}

/**
 * Um POST por telefone. O serviço whatsapp/index.js exige `telefone` e
 * `mensagem` no corpo e o token em `Authorization: Bearer` — mandar só a
 * mensagem, como era antes, voltava 400 e nada chegava.
 */
/**
 * Traduz o erro de rede do fetch. 'fetch failed' sozinho não diz nada; o
 * código em `cause` é que separa porta errada (ECONNREFUSED) de host errado
 * (ENOTFOUND) de serviço lento (timeout).
 */
function motivoDeRede(e) {
  if (e.name === 'AbortError') return 'tempo esgotado (10s sem resposta)';
  const codigo = e.cause && (e.cause.code || e.cause.errno);
  const dicas = {
    ECONNREFUSED: 'conexão recusada — o endereço responde, mas nada escuta nessa porta',
    ENOTFOUND: 'host não encontrado — confira o nome do serviço no endereço',
    EAI_AGAIN: 'DNS não resolveu o host',
    ETIMEDOUT: 'a conexão expirou antes de completar',
    ECONNRESET: 'a conexão caiu no meio do envio',
  };
  if (codigo) return `${codigo}: ${dicas[codigo] || e.message}`;
  return e.message;
}

/**
 * Um POST por telefone. Devolve o resultado de cada um para que o endpoint de
 * teste possa mostrar o que aconteceu, em vez de só "mandei".
 */
async function enviarWhatsApp(texto) {
  const telefones = telefonesDestino();
  if (!telefones.length) return [];  // ninguém cadastrado para receber
  const { url, token } = canalWhatsApp();
  if (!url) {
    log('sem endereço do serviço de WhatsApp; nada enviado.');
    return telefones.map((telefone) => ({
      telefone, ok: false, erro: 'endereço do serviço de WhatsApp não configurado',
    }));
  }

  const resultados = [];
  for (const telefone of telefones) {
    const controle = new AbortController();
    const timer = setTimeout(() => controle.abort(), 10000);
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: /^Bearer /i.test(token) ? token : `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ telefone, mensagem: texto }),
        signal: controle.signal,
      });
      const corpo = (await r.text().catch(() => '')).slice(0, 200);
      if (!r.ok) {
        log('WhatsApp recusado para', telefone, '-', r.status, corpo);
        resultados.push({ telefone, ok: false, status: r.status, erro: corpo || `HTTP ${r.status}` });
      } else {
        log('WhatsApp enviado para', telefone);
        resultados.push({ telefone, ok: true, status: r.status });
      }
    } catch (e) {
      const motivo = motivoDeRede(e);
      log('falha ao avisar WhatsApp', telefone, '-', motivo);
      resultados.push({ telefone, ok: false, erro: motivo });
    } finally {
      clearTimeout(timer);
    }
  }
  return resultados;
}

/** Dispara o aviso pelos canais configurados. */
async function avisar(assunto, texto) {
  await enviarEmail(assunto, texto);
  await enviarWhatsApp(texto);
}

/**
 * Aviso de check-in confirmado. Respeita a chave liga/desliga de
 * Configurações → Avisos de check-in; os avisos de falha seguem sempre.
 */
async function avisarCheckin(assunto, texto) {
  if (preferencias().checkinConfirmado === false) {
    log('aviso de check-in confirmado desligado nas configurações.');
    return;
  }
  await avisar(assunto, texto);
}

/* ------------------------------------------------------------------------- *
 *  CICLO
 * ------------------------------------------------------------------------- */

function rotulo(c) { return c.nome || c.gympassId || '?'; }

const FUSO = process.env.TZ_ESTUDIO || 'America/Sao_Paulo';

/** '14:32' no fuso do estúdio; devolve '—' se a data não vier. */
function horaCurta(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString('pt-BR', {
      timeZone: FUSO, hour: '2-digit', minute: '2-digit',
    });
  } catch (e) { return '—'; }
}

/** Uma linha por aluno: nome, hora do check-in e hora da confirmação. */
function linhaDoAluno(c) {
  return `• ${rotulo(c)} — check-in ${horaCurta(c.criadoEm)} — confirmado ${horaCurta(c.confirmadoEm)}`;
}

/**
 * Roda um ciclo completo e devolve o relatório do que aconteceu.
 * @param {object} opcoes
 *   origem   'ciclo' | 'manual'
 *   avisar   false desliga os e-mails deste ciclo (útil no teste manual)
 */
async function rodarUmaVez(opcoes = {}) {
  const origem = opcoes.origem || 'ciclo';
  const querAvisar = opcoes.avisar !== false;
  const rel = {
    em: new Date().toISOString(),
    origem,
    modo: estado.autoConfirmar ? 'automatico' : 'aviso',
    pendentes: [],
    confirmados: [],
    falhas: [],
    conferidosNoPortal: [],
    naoConferidos: [],
    erro: null,
  };
  estado.ultimoCiclo = rel;

  // Sessão fresca a cada ciclo (o x_session dura 1h; renovamos sempre).
  try {
    await portal.renovarSessao();
  } catch (e) {
    log('renovarSessao falhou:', e.message);
    rel.erro = 'renovarSessao: ' + e.message;
    if (querAvisar) {
      await avisar('⚠️ Wellhub: falha ao renovar sessão',
        'Não consegui renovar a sessão do portal. O refresh_token pode ter expirado — '
        + 'gere um novo no portal e atualize WELLHUB_PORTAL_REFRESH_TOKEN no Railway.');
    }
    return rel;
  }

  let pendentes;
  try {
    pendentes = await portal.listarPendentes();
  } catch (e) {
    log('listarPendentes falhou:', e.message);
    rel.erro = 'listarPendentes: ' + e.message;
    if (querAvisar && e.sessaoExpirada) {
      await avisar('⚠️ Wellhub: sessão recusada', 'O portal recusou a sessão ao listar a fila.');
    }
    return rel;
  }

  rel.pendentes = pendentes.map((c) => ({
    gympassId: c.gympassId, nome: c.nome, produto: c.produto,
    criadoEm: c.criadoEm, expiraEm: c.expiraEm, primeiraVez: c.primeiraVez,
  }));

  if (!pendentes.length) { log('fila vazia.'); return rel; }
  log(`fila com ${pendentes.length} pendente(s).`);

  const nomes = pendentes.map(rotulo).join(', ');

  if (!estado.autoConfirmar) {
    if (querAvisar) {
      await avisar(
        `🟡 Wellhub: ${pendentes.length} check-in(s) para confirmar`,
        `Há ${pendentes.length} check-in(s) aguardando confirmação:\n\n${nomes}\n\n`
        + `Confirme em: https://partners.gympass.com/validation/${portal.SLUG}`
      );
    }
    return rel;
  }

  // Modo automático ligado.
  for (const c of pendentes) {
    try {
      const r = await portal.confirmar(c);
      log('confirmar', c.gympassId, r.ok ? 'OK' : `falhou (${r.motivo})`);
      if (r.ok) {
        rel.confirmados.push({
          gympassId: c.gympassId,
          nome: c.nome,
          produto: c.produto,
          criadoEm: c.criadoEm,
          primeiraVez: c.primeiraVez,
          confirmadoEm: new Date().toISOString(),
        });
      }
      else rel.falhas.push({ gympassId: c.gympassId, nome: c.nome, motivo: r.motivo });
    } catch (e) {
      log('confirmar', c.gympassId, 'erro:', e.message);
      rel.falhas.push({ gympassId: c.gympassId, nome: c.nome, motivo: e.message });
    }
  }

  // Conferência de fechamento: o portal precisa mostrar o check-in como validado.
  // Sem isso, "confirmei" é só o que o nosso lado achou que aconteceu.
  if (rel.confirmados.length) {
    try {
      const validados = await portal.listarValidados();
      const idsValidados = new Set(validados.map((v) => String(v.gympassId)));
      for (const c of rel.confirmados) {
        if (idsValidados.has(String(c.gympassId))) rel.conferidosNoPortal.push(c);
        else rel.naoConferidos.push(c);
      }
    } catch (e) {
      log('conferência pós-confirmação falhou:', e.message);
      rel.erro = 'conferencia: ' + e.message;
    }

    if (querAvisar) {
      const n = rel.confirmados.length;
      const assunto = n === 1
        ? `✅ Check-in confirmado — ${rotulo(rel.confirmados[0])}`
        : `✅ ${n} check-ins confirmados no Wellhub`;

      const corpo = [];
      corpo.push(n === 1
        ? 'Check-in confirmado automaticamente no Wellhub:'
        : `${n} check-ins confirmados automaticamente no Wellhub:`);
      corpo.push('');
      corpo.push(rel.confirmados.map(linhaDoAluno).join('\n'));

      // A conferência é o que separa "mandei confirmar" de "o portal registrou".
      if (rel.naoConferidos.length) {
        corpo.push('');
        corpo.push('⚠️ O portal ainda não mostra como validado:');
        corpo.push(rel.naoConferidos.map((c) => `• ${rotulo(c)}`).join('\n'));
        corpo.push('Confira em https://partners.gympass.com/validation/' + portal.SLUG);
      } else if (rel.conferidosNoPortal.length === n) {
        corpo.push('');
        corpo.push('Todos conferidos como validados no portal.');
      }

      await avisarCheckin(assunto, corpo.join('\n'));
    }
  }

  if (rel.falhas.length && querAvisar) {
    await avisar(`⚠️ Wellhub: ${rel.falhas.length} check-in(s) não confirmado(s)`,
      rel.falhas.map((f) => `${rotulo(f)} — ${f.motivo}`).join('\n'));
  }

  return rel;
}

function iniciar() {
  if (!ATIVO) return;
  log(`ligado: a cada ${MINUTOS}min, auto-confirmar=${estado.autoConfirmar}, `
    + `e-mail=[${emailsDestino().join(', ') || '-'}], whatsapp=[${telefonesDestino().join(', ') || '-'}]`);
  rodarUmaVez().catch((e) => log('erro:', e.message));
  setInterval(() => rodarUmaVez().catch((e) => log('erro:', e.message)), MINUTOS * 60000);
}

/** Dispara um aviso de teste imediato (sem depender de check-in na fila). */
async function testarAviso() {
  const assunto = '✅ Wellhub: teste de aviso';
  const texto = 'Este é um teste de aviso do check-in Wellhub.\n\n'
    + 'Se você recebeu isto, o canal está funcionando.';

  await enviarEmail(assunto, texto);
  const whatsapp = await enviarWhatsApp(texto);
  const { url } = canalWhatsApp();

  return {
    ok: whatsapp.every((r) => r.ok),
    emails: emailsDestino(),
    // Endereço sem credencial: é o campo que mais erra e o que ninguém consegue
    // conferir sem abrir o volume.
    enderecoWhatsApp: url ? url.replace(/\/\/[^@/]+@/, '//***@') : null,
    whatsapp,
  };
}

module.exports = {
  iniciar, rodarUmaVez, testarAviso, situacao, definirAuto,
  motivoDeRede, canalWhatsApp,
};
