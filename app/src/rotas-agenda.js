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

/**
 * Canal 'aberto' = entra só com o telefone, sem código.
 *
 * Serve para rodar os primeiros testes antes de existir um número de WhatsApp
 * para o estúdio. Quem souber o telefone de alguém entra como essa pessoa, e
 * por isso ADMINISTRADOR NUNCA entra sem código, mesmo com o canal aberto:
 * senão qualquer aluno digitaria o telefone do dono e cairia direto nas
 * configurações e na lista de todos os alunos. O código do administrador sai
 * pelo canal normal — em modo de teste, no log do servidor.
 */
function entraSemCodigo(telefone) {
  return config.ler().acesso.canalDoCodigo === 'aberto' && !ehAdmin(telefone);
}

/* --------------------------- aniversário --------------------------------- */
// Guardamos só dia e mês, no formato 'MM-DD'. Sem ano: não precisamos da
// idade de ninguém, e menos dado guardado é menos dado a proteger.

const DIAS_NO_MES = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Aceita '07/03', '7/3', '03-07' (dia-mês) ou já no formato 'MM-DD'. */
function normalizarAniversario(entrada) {
  const texto = String(entrada || '').trim();
  if (!texto) return null;

  const partes = texto.split(/[\/\-.]/).map((p) => p.trim());
  if (partes.length !== 2 || partes.some((p) => !/^\d{1,2}$/.test(p))) return null;

  // 'MM-DD' vem do próprio banco; o resto vem do usuário como dia/mês.
  const ehCanonico = /^\d{2}-\d{2}$/.test(texto);
  const dia = Number(ehCanonico ? partes[1] : partes[0]);
  const mes = Number(ehCanonico ? partes[0] : partes[1]);

  if (mes < 1 || mes > 12) return null;
  if (dia < 1 || dia > DIAS_NO_MES[mes - 1]) return null;
  return `${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

/** 'MM-DD' → '07/03', para mostrar na tela. */
function mostrarAniversario(mmdd) {
  if (!mmdd) return null;
  const [m, d] = mmdd.split('-');
  return `${d}/${m}`;
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

  // Canal aberto: não gera nem envia código. A tela pula direto para o cadastro.
  if (entraSemCodigo(telefone)) {
    return res.json({
      enviado: true,
      canal: 'aberto',
      semCodigo: true,
      telefone: mostrarTelefone(telefone),
      precisaDeNome: !cadastrado || !cadastrado.nome,
      precisaDeAniversario: !cadastrado || !cadastrado.aniversario,
    });
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
    precisaDeAniversario: !cadastrado || !cadastrado.aniversario,
  });
});

rotas.post('/auth/entrar', (req, res) => {
  const c = config.ler();
  const telefone = normalizarTelefone(req.body.telefone);
  if (!telefone) return res.status(400).json({ erro: 'Telefone inválido.' });

  if (!entraSemCodigo(telefone)) {
    const conferencia = store.conferirCodigo(
      telefone, String(req.body.codigo || '').trim(), Number(c.acesso.maxTentativas || 5));
    if (!conferencia.ok) return res.status(401).json({ erro: conferencia.motivo });
  } else {
    console.warn(`[acesso] ${telefone} entrou sem código (canal aberto).`);
  }

  const nome = String(req.body.nome || '').trim();
  const existente = store.aluno(telefone);

  // Primeiro acesso deste telefone: nome e aniversário são obrigatórios.
  if (!existente || !existente.nome) {
    if (!nome) return res.status(400).json({ erro: 'Informe como você quer ser chamado.' });
  }

  let aniversario = (existente && existente.aniversario) || null;
  if (req.body.aniversario !== undefined && String(req.body.aniversario).trim()) {
    aniversario = normalizarAniversario(req.body.aniversario);
    if (!aniversario) {
      return res.status(400).json({ erro: 'Aniversário inválido. Use dia e mês, como 07/03.' });
    }
  }
  if (!aniversario) {
    return res.status(400).json({ erro: 'Informe seu aniversário (dia e mês).' });
  }

  const aluno = store.salvarAluno(telefone, {
    nome: nome || (existente && existente.nome) || null,
    aniversario,
    ultimoAcesso: new Date().toISOString(),
  });

  const token = store.abrirSessao(telefone, Number(c.acesso.diasDeSessao || 7));
  res.json({
    token,
    diasDeSessao: Number(c.acesso.diasDeSessao || 7),
    aluno: {
      nome: aluno.nome,
      telefone: mostrarTelefone(telefone),
      aniversario: mostrarAniversario(aluno.aniversario),
      admin: ehAdmin(telefone),
    },
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
      aniversario: mostrarAniversario(req.aluno.aniversario),
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

  if (novo.acesso && novo.acesso.canalDoCodigo !== undefined) {
    const canais = ['log', 'whatsapp', 'sms', 'aberto'];
    if (!canais.includes(novo.acesso.canalDoCodigo)) {
      return res.status(400).json({ erro: 'Canal do código inválido.' });
    }
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
    ...a,
    telefoneFormatado: mostrarTelefone(a.telefone),
    aniversarioFormatado: mostrarAniversario(a.aniversario),
    admin: ehAdmin(a.telefone),
  })));
});

rotas.put('/admin/alunos/:telefone', exigirLogin, exigirAdmin, (req, res) => {
  const telefone = normalizarTelefone(req.params.telefone);
  if (!telefone) return res.status(400).json({ erro: 'Telefone inválido.' });
  const campos = {};
  if (req.body.nome !== undefined) campos.nome = String(req.body.nome).trim() || null;
  if (req.body.bloqueado !== undefined) campos.bloqueado = Boolean(req.body.bloqueado);
  if (req.body.aniversario !== undefined) {
    const texto = String(req.body.aniversario).trim();
    if (!texto) {
      campos.aniversario = null;
    } else {
      const limpo = normalizarAniversario(texto);
      if (!limpo) return res.status(400).json({ erro: 'Aniversário inválido. Use dia e mês, como 07/03.' });
      campos.aniversario = limpo;
    }
  }
  res.json(store.salvarAluno(telefone, campos));
});

rotas.get('/admin/backup', exigirLogin, exigirAdmin, (_req, res) => {
  res.json(store.backup.situacao());
});

rotas.delete('/admin/alunos/:telefone', exigirLogin, exigirAdmin, (req, res) => {
  const telefone = normalizarTelefone(req.params.telefone);
  if (!telefone) return res.status(400).json({ erro: 'Telefone inválido.' });
  if (ehAdmin(telefone)) return res.status(400).json({ erro: 'Remova da lista de administradores primeiro.' });
  store.removerAluno(telefone);
  res.json({ ok: true });
});

module.exports = {
  rotas, normalizarTelefone, mostrarTelefone, ehAdmin,
  normalizarAniversario, mostrarAniversario,
};
