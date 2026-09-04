'use strict';

const express = require('express');
const path = require('path');
const store = require('./store');
const wellhub = require('./wellhub');
const pollerPortal = require('./poller-portal');
const checkinsStore = require('./checkins-store');
const matriculas = require('./matriculas-store');
const alertasFrequencia = require('./alertas-frequencia');
const aniversariantes = require('./aniversariantes-dia');
const agendadorMensagens = require('./agendador-mensagens');
const planilhaAlunos = require('./planilha-alunos');
const configApp = require('./config');
const { lerCheckin } = require('./payload-map');

const app = express();
const PORTA = process.env.PORT || 3000;
const TOKEN_PAINEL = process.env.PANEL_TOKEN || '';
const TOKEN_CATRACA = process.env.DEVICE_TOKEN || '';
const ACEITAR_SEM_ASSINATURA = String(process.env.ACEITAR_SEM_ASSINATURA || 'false') === 'true';

app.use(express.json({
  limit: '256kb',
  verify: (req, _res, buf) => { req.corpoBruto = buf; },
}));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Agendamento de horários: login por telefone, reserva e configurações
app.use('/agenda-api', require('./rotas-agenda').rotas);

// Tablet da entrada: confirmação de presença e cadastro, sem login
app.use('/totem-api', require('./rotas-totem').rotas);

function log(...args) { console.log(new Date().toISOString(), ...args); }

/* ---------------------------------------------------------------------------
   Webhook do Wellhub — chega sozinho, assim que o aluno faz check-in no app
--------------------------------------------------------------------------- */
app.post('/wellhub/webhook/checkin', (req, res) => {
  const assinatura = req.get('X-Gympass-Signature');
  const conferencia = wellhub.assinaturaConfere(req.corpoBruto || Buffer.from(''), assinatura);

  if (!conferencia.valida && !ACEITAR_SEM_ASSINATURA) {
    log('[webhook] assinatura recusada:', conferencia.motivo);
    return res.status(401).json({ erro: 'Assinatura inválida.' });
  }
  if (!conferencia.valida) log('[webhook] ATENÇÃO: aceito sem conferir assinatura —', conferencia.motivo);

  let checkin;
  try {
    checkin = lerCheckin(req.body);
  } catch (erro) {
    log('[webhook] payload ilegível:', erro.message);
    return res.status(400).json({ erro: 'Payload fora do formato esperado.' });
  }

  if (!checkin.gympassId) {
    log('[webhook] payload sem Wellhub ID:', JSON.stringify(req.body).slice(0, 400));
    return res.status(400).json({ erro: 'Payload sem Wellhub ID.' });
  }

  const salvo = store.salvarCheckin(checkin);
  log('[webhook] check-in recebido:', salvo.gympassId, salvo.nome || '');

  // Responde rápido: o Wellhub tem timeout e reenvia em caso de demora.
  res.status(200).json({ recebido: true });

  if (String(process.env.VALIDAR_AUTOMATICO || 'false') === 'true') {
    validar(salvo, 'automatico').catch((e) => log('[auto] falhou:', e.message));
  }
});

/* ---------------------------------------------------------------------------
   Núcleo da validação — usado pelo painel, pela catraca e pelo modo automático
--------------------------------------------------------------------------- */
async function validar(checkin, origem) {
  if (store.situacao(checkin) === 'validado') {
    return { ok: true, jaValidado: true, motivo: 'Este check-in já estava validado.' };
  }
  if (store.situacao(checkin) === 'expirado') {
    store.marcar(checkin.id, 'recusado', { origem, motivo: 'Janela de validade encerrada.' });
    return { ok: false, motivo: 'Janela de validade encerrada. Peça um novo check-in no app.' };
  }

  const r = await wellhub.validarAcesso(checkin.gympassId, checkin.gymId || wellhub.GYM_ID);

  // Falha de rede não vira recusa: o check-in continua aguardando para nova tentativa.
  if (!r.ok && r.rede) {
    log('[validar] rede falhou para', checkin.gympassId);
    return { ok: false, tentarDeNovo: true, motivo: r.motivo };
  }

  store.marcar(checkin.id, r.ok ? 'validado' : 'recusado', { origem, motivo: r.motivo });

  // O histórico de frequência não pode depender só do poller do portal: quando
  // a API oficial estiver liberada, o check-in chega por aqui e precisa contar
  // do mesmo jeito. `checkins-store` deduplica por aluno e dia, então os dois
  // caminhos podem registrar o mesmo treino sem duplicar.
  if (r.ok) {
    try {
      checkinsStore.registrar({
        gympassId: checkin.gympassId,
        nome: [checkin.nome, checkin.sobrenome].filter(Boolean).join(' ') || null,
        produto: checkin.produto || null,
        criadoEm: checkin.criadoEm || new Date().toISOString(),
      }, origem === 'catraca' ? 'catraca' : 'webhook');
    } catch (e) {
      log('[validar] não consegui gravar no histórico:', e.message);
    }
  }

  log('[validar]', checkin.gympassId, r.ok ? 'LIBERADO' : `NEGADO (${r.motivo})`, `via ${origem}`);
  return { ok: r.ok, motivo: r.motivo, simulado: r.simulado };
}

/* ---------------------------------------------------------------------------
   API do painel da recepção
--------------------------------------------------------------------------- */
function exigirPainel(req, res, next) {
  if (!TOKEN_PAINEL) return next(); // sem token configurado, acesso liberado
  if (req.get('X-Panel-Token') === TOKEN_PAINEL) return next();
  return res.status(401).json({ erro: 'Token do painel inválido.' });
}

const painel = express.Router();
painel.use(exigirPainel);

painel.get('/resumo', (_req, res) => {
  res.json({ ...store.resumo(), simulacao: wellhub.SIMULAR });
});

painel.get('/checkins', (req, res) => {
  res.json(store.listarCheckins({
    situacao: req.query.situacao,
    busca: req.query.busca,
    limite: Number(req.query.limite || 100),
  }));
});

painel.post('/checkins/:id/validar', async (req, res) => {
  const alvo = store.listarCheckins({ situacao: 'todos', limite: 5000 })
    .find((c) => c.id === req.params.id);
  if (!alvo) return res.status(404).json({ erro: 'Check-in não encontrado.' });
  res.json(await validar(alvo, 'recepcao'));
});

/** Recepção digita o Wellhub ID direto (aluno esqueceu de mostrar a tela). */
painel.post('/validar-por-id', async (req, res) => {
  const gympassId = String(req.body.gympassId || '').trim();
  if (!gympassId) return res.status(400).json({ erro: 'Informe o Wellhub ID.' });

  const ativo = store.checkinAtivo(gympassId);
  if (!ativo) {
    return res.status(404).json({
      ok: false,
      motivo: 'Nenhum check-in ativo. O aluno precisa fazer o check-in no app do Wellhub.',
    });
  }
  res.json(await validar(ativo, 'recepcao'));
});

painel.get('/alunos', (_req, res) => res.json(store.listarAlunos()));

/** Vincula QR/PIN ao aluno, aqui e no Wellhub. */
painel.put('/alunos/:gympassId/codigo', async (req, res) => {
  const { gympassId } = req.params;
  const codigo = String(req.body.codigo || '').trim();
  const resposta = await wellhub.gravarCodigo(gympassId, codigo, codigo ? 'POST' : 'DELETE');
  store.definirCodigo(gympassId, codigo || null);
  res.json({ ok: resposta.ok, status: resposta.status, codigo: codigo || null });
});

app.use('/api', painel);

/* ---------------------------------------------------------------------------
   Catraca / totem — recebe o código lido e devolve abrir: true | false
--------------------------------------------------------------------------- */
app.post('/acesso', async (req, res) => {
  if (TOKEN_CATRACA && req.get('X-Device-Token') !== TOKEN_CATRACA) {
    return res.status(401).json({ abrir: false, mensagem: 'Dispositivo não autorizado.' });
  }

  const entrada = String(req.body.codigo || req.body.gympassId || '').trim();
  if (!entrada) return res.status(400).json({ abrir: false, mensagem: 'Nenhum código recebido.' });

  const aluno = store.alunoPorCodigo(entrada);
  const gympassId = aluno ? aluno.gympassId : entrada;
  const ativo = store.checkinAtivo(gympassId);

  if (!ativo) {
    return res.json({
      abrir: false,
      mensagem: 'Sem check-in ativo. Abra o app do Wellhub e faça o check-in.',
    });
  }

  const r = await validar(ativo, 'catraca');
  res.json({
    abrir: r.ok,
    nome: [ativo.nome, ativo.sobrenome].filter(Boolean).join(' ') || null,
    mensagem: r.ok ? 'Acesso liberado.' : r.motivo,
  });
});

/* ---------------------------------------------------------------------------
   Utilitários
--------------------------------------------------------------------------- */
/* Token do painel aceito na querystring (?token=) ou no cabeçalho X-Panel-Token.
   A querystring existe para você conseguir abrir isto do celular, sem ferramenta. */
function tokenPainelConfere(req) {
  const esperado = process.env.PANEL_TOKEN || '';
  if (!esperado) return true; // sem token configurado, acesso liberado
  return req.query.token === esperado || req.get('X-Panel-Token') === esperado;
}

/* Dispara um e-mail (e WhatsApp, se houver) de teste. Protegido por PANEL_TOKEN. */
app.get('/wellhub/teste-aviso', async (req, res) => {
  if (!tokenPainelConfere(req)) {
    return res.status(401).json({ ok: false, erro: 'Token inválido. Use ?token=SEU_PANEL_TOKEN' });
  }
  try {
    const r = await pollerPortal.testarAviso();
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

/* Reimporta `teamrausch/checkins-historico.json` (repo privado) para dentro do
   histórico de check-ins. Roda sozinho no boot; isto é para rodar de novo depois
   de atualizar o arquivo com um relatório novo do portal, sem esperar deploy.
   Seguro repetir: a chave `gympassId|data` deduplica. Protegido por PANEL_TOKEN. */
app.all('/wellhub/checkins/importar-historico', async (req, res) => {
  if (!tokenPainelConfere(req)) {
    return res.status(401).json({ ok: false, erro: 'Token inválido. Use ?token=SEU_PANEL_TOKEN' });
  }
  try {
    res.json(await checkinsStore.importarHistorico());
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

/* Reaplica os telefones de `teamrausch/telefones.json` (repo privado) nas
   matrículas que ainda estão sem telefone. Nunca sobrescreve o que já foi
   preenchido na ficha. Roda sozinho no boot; isto é para rodar de novo depois
   de atualizar o arquivo, sem esperar deploy. Protegido por PANEL_TOKEN. */
app.get('/matriculas/telefones/aplicar', async (req, res) => {
  if (!tokenPainelConfere(req)) {
    return res.status(401).json({ ok: false, erro: 'Token inválido. Use ?token=SEU_PANEL_TOKEN' });
  }
  try {
    res.json(await matriculas.complementarTelefones());
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

/* Resolve as grades antigas que ficaram com dois horários no mesmo dia: fica o
   mais cedo do dia. Mostra o que faria; só mexe com `?aplicar=1`. Protegido por
   PANEL_TOKEN. Vale a pena rodar seco antes e conferir a lista. */
app.all('/matriculas/grade/reduzir', (req, res) => {
  if (!tokenPainelConfere(req)) {
    return res.status(401).json({ ok: false, erro: 'Token inválido. Use ?token=SEU_PANEL_TOKEN' });
  }
  const aplicar = String(req.query.aplicar || req.body?.aplicar || '') === '1';
  try {
    res.json(matriculas.reduzirGradesEmConflito({ seco: !aplicar }));
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

/* Reaplica `teamrausch/wellhub-ids.json` (repo privado) nas fichas que ainda
   estão sem Wellhub ID. Nunca sobrescreve vínculo existente. Roda sozinho no
   boot; isto é para rodar de novo depois de acrescentar IDs ao arquivo, sem
   esperar deploy. Protegido por PANEL_TOKEN. */
app.all('/matriculas/wellhub/aplicar', async (req, res) => {
  if (!tokenPainelConfere(req)) {
    return res.status(401).json({ ok: false, erro: 'Token inválido. Use ?token=SEU_PANEL_TOKEN' });
  }
  try {
    const r = await matriculas.complementarWellhubIds();
    // Órfão do mesmo ID passa a ter dono: sem esta passada, o histórico só
    // ligaria no próximo check-in da pessoa.
    const religados = checkinsStore.revincularOrfaos();
    res.json({ ...r, religados });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

/* ---------------------------------------------------------------------------
   Poller do portal Wellhub — estado, chave liga/desliga e ciclo sob demanda
   Tudo protegido por PANEL_TOKEN. Aceita GET para abrir direto do navegador.
--------------------------------------------------------------------------- */

/** Como está agora: modo, intervalo e relatório do último ciclo. */
app.all('/wellhub/poller', (req, res) => {
  if (!tokenPainelConfere(req)) {
    return res.status(401).json({ ok: false, erro: 'Token inválido. Use ?token=SEU_PANEL_TOKEN' });
  }
  res.json({ ok: true, ...pollerPortal.situacao() });
});

/** Liga/desliga a confirmação automática. ?auto=true | ?auto=false */
app.all('/wellhub/poller/auto', (req, res) => {
  if (!tokenPainelConfere(req)) {
    return res.status(401).json({ ok: false, erro: 'Token inválido. Use ?token=SEU_PANEL_TOKEN' });
  }
  const bruto = req.query.auto !== undefined ? req.query.auto : (req.body || {}).auto;
  if (bruto === undefined) {
    return res.status(400).json({ ok: false, erro: 'Informe auto=true ou auto=false.' });
  }
  const ligado = bruto === true || String(bruto).toLowerCase() === 'true';
  log('[poller] auto-confirmar →', ligado);
  res.json({ ok: true, ...pollerPortal.definirAuto(ligado, 'endpoint') });
});

/** Roda um ciclo agora, sem esperar os 15 min. ?avisar=false suprime o e-mail. */
app.all('/wellhub/poller/rodar', async (req, res) => {
  if (!tokenPainelConfere(req)) {
    return res.status(401).json({ ok: false, erro: 'Token inválido. Use ?token=SEU_PANEL_TOKEN' });
  }
  const querAvisar = String(req.query.avisar || 'true').toLowerCase() !== 'false';
  try {
    const rel = await pollerPortal.rodarUmaVez({ origem: 'manual', avisar: querAvisar });
    res.json({ ok: !rel.erro, relatorio: rel });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

/* ---------------------------------------------------------------------------
   Cadastro de alunos por planilha do Google

   A leitura acontece sozinha uma vez por dia (PLANILHA_ALUNOS_HORA). Estas
   rotas existem para conferir o estado e para forçar uma leitura sem esperar,
   quando alguém acabou de cadastrar um aluno e quer ver a ficha na hora.
--------------------------------------------------------------------------- */

/** Estado do agendador e o resultado da última leitura. */
app.all('/alunos/planilha', (req, res) => {
  if (!tokenPainelConfere(req)) {
    return res.status(401).json({ ok: false, erro: 'Token inválido. Use ?token=SEU_PANEL_TOKEN' });
  }
  res.json({ ok: true, ...planilhaAlunos.situacao() });
});

/**
 * Lê a planilha agora. Só cadastra quem ainda não tem ficha; quem já existe
 * entra em `ignoradas` e nada é reescrito. `?seco=1` mostra o que aconteceria
 * sem gravar — é como se confere um link novo antes de soltá-lo na base.
 */
app.all('/alunos/planilha/sincronizar', async (req, res) => {
  if (!tokenPainelConfere(req)) {
    return res.status(401).json({ ok: false, erro: 'Token inválido. Use ?token=SEU_PANEL_TOKEN' });
  }
  const seco = ['1', 'true', 'sim'].includes(String(req.query.seco || '').toLowerCase());
  try {
    const r = await planilhaAlunos.rodar({ origem: 'manual', seco });
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

/**
 * Sonda o serviço de WhatsApp pela rede privada, sem enviar mensagem nenhuma.
 * Existe porque "fetch failed" no envio não distingue nome de serviço errado
 * de porta errada, e o hostname interno só aparece no painel do Railway.
 *
 *   /wellhub/whatsapp/sondar?token=...&host=whatsapp&porta=8080
 *
 * Restrito à rede interna do Railway de propósito: este endpoint não serve
 * para buscar endereço arbitrário.
 */
app.all('/wellhub/whatsapp/sondar', async (req, res) => {
  if (!tokenPainelConfere(req)) {
    return res.status(401).json({ ok: false, erro: 'Token inválido. Use ?token=SEU_PANEL_TOKEN' });
  }
  const q = { ...(req.body || {}), ...req.query };
  const bruto = String(q.host || 'whatsapp').trim().toLowerCase();
  const porta = Number(q.porta || 8080);
  const caminho = String(q.caminho || '/status');

  if (!/^[a-z0-9][a-z0-9-]*(\.railway\.internal)?$/.test(bruto)) {
    return res.status(400).json({ ok: false, erro: 'Host inválido. Use só o nome do serviço.' });
  }
  if (!Number.isInteger(porta) || porta < 1 || porta > 65535) {
    return res.status(400).json({ ok: false, erro: 'Porta inválida.' });
  }
  if (!/^\/[a-z0-9/_-]*$/.test(caminho)) {
    return res.status(400).json({ ok: false, erro: 'Caminho inválido.' });
  }

  const host = bruto.endsWith('.railway.internal') ? bruto : `${bruto}.railway.internal`;
  const alvo = `http://${host}:${porta}${caminho}`;

  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(), 8000);
  try {
    const r = await fetch(alvo, { signal: controle.signal });
    const corpo = (await r.text().catch(() => '')).slice(0, 300);
    res.json({ ok: r.ok, alvo, status: r.status, corpo });
  } catch (e) {
    res.json({ ok: false, alvo, erro: pollerPortal.motivoDeRede(e) });
  } finally {
    clearTimeout(timer);
  }
});

/* ---------------------------------------------------------------------------
   Frequência — panorama e aviso, abríveis do celular com ?token=PANEL_TOKEN
--------------------------------------------------------------------------- */

/** Quem está devendo treino na janela. ?dias=7 &todos=1 mostra a base inteira. */
app.all('/wellhub/frequencia', (req, res) => {
  if (!tokenPainelConfere(req)) {
    return res.status(401).json({ ok: false, erro: 'Token inválido. Use ?token=SEU_PANEL_TOKEN' });
  }
  try {
    const painel = alertasFrequencia.montarPainel({
      dias: Number(req.query.dias) || undefined,
      vinculo: req.query.vinculo === 'todos' ? null : undefined,
    });
    const so = String(req.query.so || 'devendo');
    res.json({
      ok: true,
      janela: painel.janela,
      resumo: painel.resumo,
      checkins: checkinsStore.resumo(),
      alunos: so === 'todos' ? painel.alunos : painel.alunos.filter(
        (a) => a.situacao === 'atrasado' || a.situacao === 'critico'),
    });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

/** Dispara o aviso de frequência agora. ?enviar=1 manda; sem isso, só mostra. */
app.all('/wellhub/frequencia/aviso', async (req, res) => {
  if (!tokenPainelConfere(req)) {
    return res.status(401).json({ ok: false, erro: 'Token inválido. Use ?token=SEU_PANEL_TOKEN' });
  }
  try {
    const r = await alertasFrequencia.rodar({
      avisar: String(req.query.enviar || '') === '1',
      mesmoSemDevedores: true,
    });
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

/**
 * Aniversariantes de hoje, do jeito que a operação recebe às 5h30.
 * ?enviar=1 manda para o grupo; sem isso é só pré-visualização.
 * ?data=YYYY-MM-DD confere outro dia sem esperar ele chegar.
 */
app.all('/wellhub/aniversariantes', async (req, res) => {
  if (!tokenPainelConfere(req)) {
    return res.status(401).json({ ok: false, erro: 'Token inválido. Use ?token=SEU_PANEL_TOKEN' });
  }
  try {
    const r = await aniversariantes.rodar({
      data: req.query.data || undefined,
      avisar: String(req.query.enviar || '') === '1',
      mesmoSemNinguem: true,
    });
    res.json({ ok: true, ...r, agendador: aniversariantes.situacao() });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

/* ---------------------------------------------------------------------------
   WhatsApp — pareamento do número pela rede privada

   O serviço de WhatsApp não tem domínio público de propósito: quem fala com
   ele é este app, pela rede interna do Railway. Mas o pareamento precisa de um
   QR na tela, e o `/qr` de lá só aceita token em cabeçalho — coisa que o
   navegador não manda. Estas rotas fazem a ponte: abra
   `/whatsapp/qr?token=SEU_PANEL_TOKEN` no celular e leia o código.

   O QR do WhatsApp expira em segundos, então a página recarrega sozinha
   enquanto o número não estiver conectado.
--------------------------------------------------------------------------- */
function baseDoWhatsApp() {
  const c = configApp.ler();
  const bruta = String((c.envio && c.envio.url) || process.env.WHATSAPP_URL || '').trim();
  if (!bruta) return null;
  // O endereço configurado aponta para o endpoint de envio; o QR mora na raiz.
  return bruta.replace(/\/+$/, '').replace(/\/(enviar|qr|status)$/i, '');
}

function tokenDoWhatsApp() {
  const c = configApp.ler();
  return String((c.envio && c.envio.token) || process.env.WHATSAPP_TOKEN || '').trim();
}

async function buscarNoWhatsApp(caminho) {
  const base = baseDoWhatsApp();
  if (!base) {
    const e = new Error('Endereço do serviço de WhatsApp não configurado. Preencha Configurações → Técnica ou WHATSAPP_URL.');
    e.semEndereco = true;
    throw e;
  }
  const cabecalhos = {};
  const t = tokenDoWhatsApp();
  if (t) cabecalhos.Authorization = /^Bearer /i.test(t) ? t : `Bearer ${t}`;

  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(), 10000);
  try {
    const r = await fetch(`${base}${caminho}`, { headers: cabecalhos, signal: controle.signal });
    return {
      status: r.status,
      corpo: await r.text(),
      tipo: r.headers.get('content-type') || '',
      alvo: `${base}${caminho}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

app.get('/whatsapp/qr', async (req, res) => {
  if (!tokenPainelConfere(req)) {
    return res.status(401).json({ ok: false, erro: 'Token inválido. Use ?token=SEU_PANEL_TOKEN' });
  }
  try {
    const r = await buscarNoWhatsApp('/qr');
    if (r.tipo.includes('json')) return res.status(r.status).type('json').send(r.corpo);

    let html = r.corpo;
    const jaConectado = /ligado ao n[úu]mero/i.test(html);
    if (!jaConectado && html.includes('</head>')) {
      html = html.replace('</head>', '<meta http-equiv="refresh" content="12"></head>');
    }
    res.status(r.status).type('html').send(html);
  } catch (e) {
    res.status(e.semEndereco ? 400 : 502)
      .json({ ok: false, erro: e.semEndereco ? e.message : pollerPortal.motivoDeRede(e) });
  }
});

/* Situação da conexão em JSON: útil para conferir sem abrir a página do QR. */
app.get('/whatsapp/status', async (req, res) => {
  if (!tokenPainelConfere(req)) {
    return res.status(401).json({ ok: false, erro: 'Token inválido. Use ?token=SEU_PANEL_TOKEN' });
  }
  try {
    const r = await buscarNoWhatsApp('/status');
    let dados = null;
    try { dados = JSON.parse(r.corpo); } catch { dados = { corpo: r.corpo.slice(0, 300) }; }
    res.status(r.status).json({ ok: r.status < 400, alvo: r.alvo, ...dados });
  } catch (e) {
    res.status(e.semEndereco ? 400 : 502)
      .json({ ok: false, erro: e.semEndereco ? e.message : pollerPortal.motivoDeRede(e) });
  }
});

app.get('/saude', (_req, res) => {
  res.json({
    ok: true,
    simulacao: wellhub.SIMULAR,
    gymId: wellhub.GYM_ID || null,
    credencial: Boolean(process.env.WELLHUB_API_KEY),
    segredoWebhook: Boolean(process.env.WELLHUB_WEBHOOK_SECRET),
  });
});

/** Injeta um check-in falso para testar tudo antes das credenciais chegarem. */
app.post('/dev/checkin-falso', (req, res) => {
  if (!wellhub.SIMULAR) return res.status(403).json({ erro: 'Disponível apenas com SIMULAR=true.' });
  const salvo = store.salvarCheckin(lerCheckin({
    gympass_id: req.body.gympassId || String(Math.floor(Math.random() * 9e7) + 1e7),
    gym_id: wellhub.GYM_ID || 'GYM-TESTE',
    user: {
      name: req.body.nome || 'Aluno',
      last_name: req.body.sobrenome || 'de Teste',
      email: 'teste@exemplo.com',
    },
    product: 'Plano Silver',
    created_at: new Date().toISOString(),
  }));
  res.json(salvo);
});

app.use((erro, _req, res, _next) => {
  log('[erro]', erro.message);
  res.status(500).json({ erro: 'Falha interna. Confira os logs do serviço.' });
});

app.listen(PORTA, () => {
  log(`Serviço no ar na porta ${PORTA}${wellhub.SIMULAR ? ' — MODO SIMULAÇÃO' : ''}`);
  pollerPortal.iniciar(); // poller do portal Wellhub (só roda se POLLER_PORTAL_ATIVO=true)
  alertasFrequencia.iniciar(); // aviso diário de quem está devendo treino
  planilhaAlunos.iniciar(); // cadastro de alunos pela planilha do Google
  agendadorMensagens.iniciar(); // modelos programados e recorrentes
  aniversariantes.iniciar(); // lista dos aniversariantes do dia para a operação
});
