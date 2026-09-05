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
const checkins = require('./checkins-store');
const matriculas = require('./matriculas-store');
const frequencia = require('./frequencia');
const telefone = require('./telefone');

const ATIVO = String(process.env.POLLER_PORTAL_ATIVO || 'false') === 'true';
const MINUTOS = Number(process.env.POLLER_PORTAL_MINUTOS || 15);
const AUTO_PADRAO = String(process.env.POLLER_PORTAL_AUTO_CONFIRMAR || 'false') === 'true';
const EMAIL_DESTINO = process.env.WELLHUB_ALERTA_EMAIL || 'davileles@gmail.com';
const EMAIL_FROM = process.env.RESEND_FROM || 'Wellhub Alertas <onboarding@resend.dev>';
const DATA_DIR = process.env.DATA_DIR || '/data';
const ARQ_ESTADO = path.join(DATA_DIR, 'poller-portal.json');
/** Aviso na hora quando alguém entra pelo produto que paga menos. */
const ALERTA_FUNCIONAL = String(process.env.FUNCIONAL_ALERTA_ATIVO || 'true') === 'true';

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
    emailsAviso: emailsDestino(),
    telefonesAviso: telefonesDestino(),
    gruposAviso: gruposDestino(),
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

/**
 * Grupos do WhatsApp que recebem os avisos (o "grupo do operador").
 *
 * Ficam em lista própria porque `telefonesDestino` tira tudo que não é dígito
 * — um JID passando por lá viraria um número inventado e o envio sumiria em
 * silêncio.
 */
function gruposDestino() {
  return (preferencias().grupos || [])
    .map((g) => String(g || '').trim())
    .filter((g) => /^\d{5,}@g\.us$/.test(g));
}

/**
 * Para onde o aviso automático sai no WhatsApp: SÓ O GRUPO DO OPERADOR.
 *
 * Enquanto a lista de telefones entrava aqui junto, cada ciclo do poller
 * repetia a mesma mensagem no privado de quem estivesse cadastrado — e é no
 * privado que ela atrapalha, porque chega misturada à conversa pessoal e não
 * some quando a pessoa deixa a operação. `telefonesDestino` continua existindo
 * para o que é conversa com uma pessoa só; aviso de máquina não é isso.
 *
 * Sem grupo cadastrado o canal fica mudo de propósito, e o log diz isso. Cair
 * de volta no privado por falta de destino seria desfazer a regra justamente
 * na hora em que ninguém está olhando.
 */
function destinosWhatsApp() {
  const grupos = gruposDestino();
  if (!grupos.length) {
    log('nenhum grupo em Configurações → Avisos: nada sai pelo WhatsApp.');
  }
  return grupos;
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
  const telefones = destinosWhatsApp();
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
        // `destino` atende telefone e grupo; `telefone` continua indo junto
        // para o caso de o serviço de WhatsApp ainda ser o de antes.
        body: JSON.stringify({ destino: telefone, telefone, mensagem: texto }),
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

/* ------------------------------------------------------------------------- *
 *  ALERTA DE PRODUTO BARATO
 *
 *  Funcional e crosstraining são o mesmo plano do lado do aluno e pagam
 *  valores diferentes do lado do estúdio. Quem entra pelo funcional não
 *  economiza nada e deixa a diferença na mesa — é a única perda do painel que
 *  se resolve com uma conversa, e não com o aluno treinando mais.
 *
 *  POR QUE NA HORA, E NÃO NO RELATÓRIO DA MANHÃ
 *  O relatório conta o que já aconteceu. Aqui o aluno acabou de entrar e ainda
 *  está no estúdio: dá para orientar na porta, antes de a marcação virar
 *  hábito. Por isso o telefone vai junto — a orientação sai no mesmo minuto,
 *  sem abrir o painel no meio do atendimento.
 *
 *  SÓ CHECK-IN NOVO E SÓ DE HOJE
 *  `registrarLote` devolve apenas o que ainda não estava no histórico, então o
 *  poller pode reler a mesma lista de validados o dia inteiro sem repetir o
 *  aviso. O corte por data protege o outro caso: num volume vazio o histórico
 *  chega inteiro de uma vez, e sem ele o primeiro ciclo depois de um deploy
 *  despejaria meses de check-ins antigos no grupo.
 * ------------------------------------------------------------------------- */

/** Quanto o crosstraining paga a mais. Zero ou negativo desliga o aviso. */
function diferencaDeProduto() {
  let precos = {};
  try { precos = config.ler().financeiro || {}; } catch (e) { /* padrões abaixo */ }
  const funcional = Number(precos.valorFuncional);
  const cross = Number(precos.valorCrosstraining);
  if (!Number.isFinite(funcional) || !Number.isFinite(cross)) return 0;
  return cross - funcional;
}

/** Telefone da ficha, já formatado para leitura. Null quando não há. */
function telefoneDaFicha(matriculaId) {
  if (!matriculaId) return null;
  const m = matriculas.porId(matriculaId);
  if (!m || !m.telefone) return null;
  return telefone.mostrar(telefone.normalizar(m.telefone) || m.telefone);
}

function reais(valor) {
  return 'R$ ' + Number(valor || 0).toLocaleString('pt-BR', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

/**
 * Avisa o grupo sobre os check-ins novos marcados como Funcional.
 *
 * @param {object[]} registros os check-ins NOVOS devolvidos por registrarLote
 * @param {boolean}  querAvisar false no teste manual: monta e não envia
 */
async function avisarProdutoBarato(registros, querAvisar) {
  if (!querAvisar || !ALERTA_FUNCIONAL) return [];
  const diferenca = diferencaDeProduto();
  if (diferenca <= 0) return [];

  const hoje = checkins.hojeLocal();
  const alvos = (registros || []).filter((c) =>
    c.data === hoje && frequencia.chaveProduto(c.produto) === 'funcional');
  if (!alvos.length) return [];

  const linhas = alvos.map((c) => {
    const nome = c.nomeMatricula || c.nome || 'Sem nome';
    const tel = telefoneDaFicha(c.matriculaId);
    const contato = tel
      || (c.matriculaId ? 'sem telefone na ficha' : 'sem ficha — vincule em Matrículas → Frequência');
    return `• ${nome} — ${contato}\n  Funcional às ${c.hora || '--:--'}`;
  });

  const n = alvos.length;
  const texto = [
    n === 1
      ? '🔻 Check-in no Funcional'
      : `🔻 ${n} check-ins no Funcional`,
    '',
    ...linhas,
    '',
    `O crosstraining paga ${reais(diferenca)} a mais por check-in e custa o mesmo `
    + 'para o aluno.',
    n === 1
      ? 'Vale um contato agora para orientar a marcar Crosstraining na próxima.'
      : 'Vale um contato agora para orientar a marcarem Crosstraining na próxima.',
  ].join('\n');

  await enviarWhatsApp(texto);
  log(`aviso de produto barato: ${n} check-in(s).`);
  return alvos;
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
 * Lê a lista de validados do portal e grava no histórico.
 *
 * Roda em TODO ciclo, não só quando o modo automático confirmou algo: no modo
 * aviso quem confirma é você, pelo site, e o nosso lado nunca ficaria sabendo.
 * A lista de validados é a única fonte que enxerga os dois caminhos.
 *
 * Devolve os validados normalizados para a conferência pós-confirmação
 * aproveitar a mesma chamada, em vez de bater no portal duas vezes.
 */
async function coletarValidados(rel, querAvisar = true) {
  try {
    const validados = await portal.listarValidados();
    rel.validados = validados.length;
    rel.registrados = checkins.registrarLote(validados, 'portal');
    // Depois de gravar, nunca antes: o aviso fala de check-in que já existe no
    // histórico, e é a gravação que garante que ele não será avisado de novo.
    const baratos = await avisarProdutoBarato(rel.registrados.registros, querAvisar);
    rel.produtoBarato = baratos.map((c) => ({
      gympassId: c.gympassId, nome: c.nomeMatricula || c.nome,
      matriculaId: c.matriculaId, hora: c.hora,
    }));
    return validados;
  } catch (e) {
    log('listarValidados falhou:', e.message);
    rel.erro = (rel.erro ? rel.erro + ' | ' : '') + 'listarValidados: ' + e.message;
    return null;
  }
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
    produtoBarato: [],
    validados: 0,
    registrados: null,
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

  if (!pendentes.length) {
    log('fila vazia.');
    await coletarValidados(rel, querAvisar);   // ninguém na fila não quer dizer que ninguém treinou
    return rel;
  }
  log(`fila com ${pendentes.length} pendente(s).`);

  const nomes = pendentes.map(rotulo).join(', ');

  if (!estado.autoConfirmar) {
    await coletarValidados(rel, querAvisar);   // pega o que você já confirmou na mão
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
  // A mesma leitura alimenta o histórico — uma chamada, dois usos.
  const validados = await coletarValidados(rel, querAvisar);

  if (rel.confirmados.length) {
    if (validados) {
      const idsValidados = new Set(validados.map((v) => String(v.gympassId)));
      for (const c of rel.confirmados) {
        if (idsValidados.has(String(c.gympassId))) rel.conferidosNoPortal.push(c);
        else rel.naoConferidos.push(c);
      }
    }

    // CONFIRMAÇÃO QUE DEU CERTO NÃO VIRA MENSAGEM
    //   É o desfecho normal de todo ciclo. Anunciá-lo transforma o grupo num
    //   letreiro que ninguém lê — e um grupo que ninguém lê também engole o
    //   aviso que importava. Quem treinou continua na aba Check-ins, que é
    //   onde se procura isso.
    //
    //   O que sobrou aqui é o único desfecho que pede ação sua: mandamos
    //   confirmar e o portal não mostra o check-in como validado. É a
    //   diferença entre "mandei confirmar" e "o Wellhub registrou" — e o que
    //   você deixa de receber é dinheiro.
    if (querAvisar && rel.naoConferidos.length) {
      const n = rel.naoConferidos.length;
      await avisar(
        `⚠️ Wellhub: ${n} check-in(s) confirmado(s) que o portal não validou`,
        [
          n === 1
            ? 'Mandei confirmar, mas o portal ainda não mostra como validado:'
            : `Mandei confirmar ${n} check-ins, mas o portal ainda não mostra como validados:`,
          '',
          rel.naoConferidos.map(linhaDoAluno).join('\n'),
          '',
          'Confira em https://partners.gympass.com/validation/' + portal.SLUG,
        ].join('\n')
      );
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
    + `e-mail=[${emailsDestino().join(', ') || '-'}], whatsapp=[${destinosWhatsApp().join(', ') || '-'}]`);
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
  // Reaproveitados pelo aviso de frequência: os destinatários e os canais já
  // estão configurados aqui, não faz sentido ter uma segunda cópia disso.
  avisar, enviarEmail, enviarWhatsApp, emailsDestino, telefonesDestino,
  gruposDestino, destinosWhatsApp,
  avisarProdutoBarato, diferencaDeProduto,
};
