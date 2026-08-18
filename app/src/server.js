'use strict';

const express = require('express');
const path = require('path');
const store = require('./store');
const wellhub = require('./wellhub');
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
});
