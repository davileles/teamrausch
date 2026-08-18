'use strict';

const express = require('express');
const crypto = require('crypto');
const config = require('./config');
const store = require('./agenda-store');
const agenda = require('./agenda');
const { enviarCodigo } = require('./mensageiro');

const rotas = express.Router();

/* --------------------------- telefone ------------------------------------ */

/** Aceita (31) 98888-7777, 31988887777, +55 31 98888-7777 → 5531988887777 */
function normalizarTelefone(entrada) {
  let n = String(entrada || '').replace(/\D/g, '');
  if (n.startsWith('55') && n.length >= 12) n = n.slice(2);
  if (n.length === 10) {
    // fixo ou celular antigo: completa o nono dígito quando for celular
    if (['6', '7', '8', '9'].includes(n[2])) n = n.slice(0, 2) + '9' + n.slice(2);
  }
  if (n.length !== 11) return null;
  const ddd = Number(n.slice(0, 2));
  if (ddd < 11 || ddd > 99) return null;
  if (n[2] !== '9') return null;
  return '55' + n;
}

function mostrarTelefone(e164) {
  const n = e164.replace(/^55/, '');
  return `(${n.slice(0, 2)}) ${n.slice(2, 7)}-${n.slice(7)}`;
}

function ehAdmin(telefone) {
  return (config.ler().administradores || []).includes(telefone);
}

/* ----------------------------- sessão ------------------------------------ */

function identificar(req, _res, next) {
  const token = (req.get('Authorization') || '').replace(/^Bearer /i, '').trim();
  const s = token ? store.sessao(token) : null;
  if (s) {
    req.aluno = store.aluno(s.telefone);
    req.token = token;
    req.admin = ehAdmin(s.telefone);
  }
  next();
}

function exigirLogin(req, res, next) {
  if (!req.aluno) return res.status(401).json({ erro: 'Entre com seu telefone.' });
  if (req.aluno.bloqueado) return res.status(403).json({ erro: 'Seu acesso está suspenso. Fale com o estúdio.' });
  next();
}

function exigirAdmin(req, res, next) {
  if (!req.admin) return res.status(403).json({ erro: 'Só administradores.' });
  next();
}

rotas.use(express.json());
rotas.use(identificar);

/* ------------------------------ login ------------------------------------ */

rotas.post('/auth/codigo', async (req, res) => {
  const c = config.ler();
  const telefone = normalizarTelefone(req.body.telefone);
  if (!telefone) {
    return res.status(400).json({ erro: 'Telefone inválido. Use DDD + número, como (31) 98888-7777.' });
  }

  const cadastrado = store.aluno(telefone);
  if (!cadastrado && !c.acesso.cadastroAberto) {
    return res.status(403).json({ erro: 'Telefone não cadastrado. Fale com o estúdio.' });
  }
  if (cadastrado && cadastrado.bloqueado) {
    return res.status(403).json({ erro: 'Seu acesso está suspenso. Fale com o estúdio.' });
  }
  if (store.pedidosNaUltimaHora(telefone) >= Number(c.acesso.maxPedidosPorHora || 5)) {
    return res.status(429).json({ erro: 'Muitos pedidos de código. Tente daqui a pouco.' });
  }

  const codigo = String(crypto.randomInt(100000, 1000000));
  store.guardarCodigo(telefone, codigo, Number(c.acesso.minutosDeValidadeDoCodigo || 10));

  const envio = await enviarCodigo(telefone, codigo);
  if (!envio.ok) return res.status(502).json({ erro: envio.motivo });

  res.json({
    enviado: true,
    canal: envio.canal,
    telefone: mostrarTelefone(telefone),
    precisaDeNome: !cadastrado || !cadastrado.nome,
  });
});

rotas.post('/auth/entrar', (req, res) => {
  const c = config.ler();
  const telefone = normalizarTelefone(req.body.telefone);
  if (!telefone) return res.status(400).json({ erro: 'Telefone inválido.' });

  const conferencia = store.conferirCodigo(
    telefone, String(req.body.codigo || '').trim(), Number(c.acesso.maxTentativas || 5));
  if (!conferencia.ok) return res.status(401).json({ erro: conferencia.motivo });

  const nome = String(req.body.nome || '').trim();
  const existente = store.aluno(telefone);
  if (!existente && !nome) return res.status(400).json({ erro: 'Informe seu nome.' });

  const aluno = store.salvarAluno(telefone, {
    nome: nome || (existente && existente.nome) || null,
    ultimoAcesso: new Date().toISOString(),
  });

  const token = store.abrirSessao(telefone, Number(c.acesso.diasDeSessao || 7));
  res.json({
    token,
    diasDeSessao: Number(c.acesso.diasDeSessao || 7),
    aluno: { nome: aluno.nome, telefone: mostrarTelefone(telefone), admin: ehAdmin(telefone) },
  });
});

rotas.post('/auth/sair', exigirLogin, (req, res) => {
  store.fecharSessao(req.token);
  res.json({ ok: true });
});

rotas.get('/auth/eu', (req, res) => {
  if (!req.aluno) return res.status(401).json({ erro: 'Sem sessão.' });
  res.json({
    aluno: {
      nome: req.aluno.nome,
      telefone: mostrarTelefone(req.aluno.telefone),
      admin: req.admin,
    },
    config: config.publica(),
  });
});

/* ----------------------------- agenda ------------------------------------ */

rotas.get('/agenda', exigirLogin, (req, res) => {
  res.json({
    dias: agenda.montarDias(req.aluno.telefone),
    meus: store.doAluno(req.aluno.telefone, agenda.hoje(config.ler().estudio.fuso))
      .map((a) => ({ ...a, porExtenso: agenda.porExtenso(a.data) })),
    recado: config.ler().estudio.recado || '',
  });
});

rotas.post('/agenda/reservar', exigirLogin, (req, res) => {
  const { data, hora } = req.body;
  const r = agenda.reservar(req.aluno, String(data || ''), String(hora || ''));
  if (!r.ok) return res.status(409).json({ erro: r.motivo });
  res.json({ ok: true, agendamento: r.agendamento });
});

rotas.post('/agenda/cancelar', exigirLogin, (req, res) => {
  const r = agenda.cancelar(req.aluno, String(req.body.id || ''), req.admin);
  if (!r.ok) return res.status(409).json({ erro: r.motivo });
  res.json({ ok: true });
});

/* --------------------------- administração ------------------------------- */

rotas.get('/admin/dia', exigirLogin, exigirAdmin, (req, res) => {
  const data = String(req.query.data || agenda.hoje(config.ler().estudio.fuso));
  res.json(agenda.listaDoDia(data));
});

rotas.get('/admin/config', exigirLogin, exigirAdmin, (_req, res) => {
  res.json(config.ler());
});

rotas.put('/admin/config', exigirLogin, exigirAdmin, (req, res) => {
  const novo = req.body || {};

  if (novo.administradores) {
    const limpos = novo.administradores
      .map(normalizarTelefone)
      .filter(Boolean);
    if (!limpos.length) {
      return res.status(400).json({ erro: 'Deixe pelo menos um administrador válido.' });
    }
    if (!limpos.includes(req.aluno.telefone)) {
      return res.status(400).json({ erro: 'Você não pode se remover da lista de administradores.' });
    }
    novo.administradores = [...new Set(limpos)];
  }

  if (novo.agenda && novo.agenda.horarios) {
    for (const dia of Object.keys(novo.agenda.horarios)) {
      if (!agenda.DIAS.includes(dia)) return res.status(400).json({ erro: `Dia inválido: ${dia}` });
      for (const slot of novo.agenda.horarios[dia]) {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.hora || '')) {
          return res.status(400).json({ erro: `Horário inválido em ${dia}: ${slot.hora}` });
        }
      }
    }
  }

  res.json(config.gravar(novo));
});

rotas.get('/admin/alunos', exigirLogin, exigirAdmin, (_req, res) => {
  res.json(store.listarAlunos().map((a) => ({
    ...a, telefoneFormatado: mostrarTelefone(a.telefone), admin: ehAdmin(a.telefone),
  })));
});

rotas.put('/admin/alunos/:telefone', exigirLogin, exigirAdmin, (req, res) => {
  const telefone = normalizarTelefone(req.params.telefone);
  if (!telefone) return res.status(400).json({ erro: 'Telefone inválido.' });
  const campos = {};
  if (req.body.nome !== undefined) campos.nome = String(req.body.nome).trim() || null;
  if (req.body.bloqueado !== undefined) campos.bloqueado = Boolean(req.body.bloqueado);
  res.json(store.salvarAluno(telefone, campos));
});

rotas.delete('/admin/alunos/:telefone', exigirLogin, exigirAdmin, (req, res) => {
  const telefone = normalizarTelefone(req.params.telefone);
  if (!telefone) return res.status(400).json({ erro: 'Telefone inválido.' });
  if (ehAdmin(telefone)) return res.status(400).json({ erro: 'Remova da lista de administradores primeiro.' });
  store.removerAluno(telefone);
  res.json({ ok: true });
});

module.exports = { rotas, normalizarTelefone, mostrarTelefone, ehAdmin };
