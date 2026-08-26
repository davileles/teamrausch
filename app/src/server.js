'use strict';

const express = require('express');
const path = require('path');
const store = require('./store');
const wellhub = require('./wellhub');
const pollerPortal = require('./poller-portal');
const checkinsStore = require('./checkins-store');
const matriculas = require('./matriculas-store');
const alertasFrequencia = require('./alertas-frequencia');
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
});
