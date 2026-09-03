'use strict';

/**
 * app/src/rotas-totem.js — davileles/teamrausch
 *
 * O tablet fixo na entrada do estúdio. Duas coisas acontecem ali, e nenhuma
 * delas exige login: confirmar a presença na aula de hoje e abrir cadastro.
 *
 * POR QUE SEM SENHA
 *   Quem está na frente do tablet já está dentro do estúdio. Pedir telefone,
 *   código no WhatsApp e digitação numa tela compartilhada, de pé, com fila
 *   atrás, é o tipo de atrito que faz todo mundo desistir e a recepção voltar a
 *   anotar em papel. A porta de entrada aqui é física.
 *
 *   O que protege é o `DEVICE_TOKEN`: definido, só o tablet configurado com ele
 *   fala com estas rotas — a mesma proteção que a catraca já usa em `/acesso`.
 *   Sem ele, qualquer um na internet consegue listar nomes por final de
 *   telefone, então em produção vale a pena defini-lo.
 *
 * QUATRO DÍGITOS, NÃO O TELEFONE INTEIRO
 *   A busca é pelos quatro últimos dígitos e devolve nome e mais nada. O
 *   telefone nunca sai daqui: o que vai para a tela é um bilhete descartável
 *   que morre em três minutos e só este servidor sabe traduzir. Assim a lista
 *   de alunos do estúdio não vira uma agenda telefônica exposta num tablet
 *   destravado em cima do balcão.
 */

const express = require('express');
const crypto = require('crypto');

const config = require('./config');
const agenda = require('./agenda');
const store = require('./agenda-store');
const matriculas = require('./matriculas-store');
const rotasAgenda = require('./rotas-agenda');

const rotas = express.Router();
rotas.use(express.json());

const TOKEN_DISPOSITIVO = process.env.DEVICE_TOKEN || '';

/**
 * Janela em que a confirmação vale, em minutos ao redor do horário da aula.
 *
 * Antes é maior que depois de propósito: as pessoas chegam cedo, trocam de
 * roupa e confirmam antes de entrar na sala. Quem confirma muito depois do
 * início ou já treinou e voltou ao tablet, ou está confirmando a aula errada.
 */
const MINUTOS_ANTES = Number(process.env.TOTEM_MINUTOS_ANTES || 45);
const MINUTOS_DEPOIS = Number(process.env.TOTEM_MINUTOS_DEPOIS || 30);

/* ---------------------------- proteção ----------------------------------- */

function doTablet(req, res, next) {
  if (TOKEN_DISPOSITIVO && req.get('X-Device-Token') !== TOKEN_DISPOSITIVO) {
    return res.status(403).json({ erro: 'Tablet não autorizado.' });
  }
  next();
}

/**
 * Freio simples por IP. Não é defesa contra ataque — é o que impede que alguém
 * varra os dez mil finais de quatro dígitos e monte a lista de alunos.
 */
const tentativas = new Map();
function comFreio(limitePorMinuto) {
  return (req, res, next) => {
    const chave = req.ip || 'desconhecido';
    const agora = Date.now();
    const recentes = (tentativas.get(chave) || []).filter((t) => t > agora - 60000);
    if (recentes.length >= limitePorMinuto) {
      return res.status(429).json({ erro: 'Muitas tentativas. Espere um pouco.' });
    }
    recentes.push(agora);
    tentativas.set(chave, recentes);
    next();
  };
}

/* ---------------------------- bilhetes ----------------------------------- */

/**
 * Ponte entre o nome que apareceu na tela e o telefone que fica no servidor.
 * Vive em memória: reiniciou o Railway, os bilhetes abertos morrem e a pessoa
 * digita os quatro dígitos de novo — três segundos de incômodo contra guardar
 * telefone em disco por nada.
 */
const bilhetes = new Map();
const VALIDADE_BILHETE = 3 * 60000;

function emitirBilhete(telefone) {
  const id = crypto.randomBytes(9).toString('hex');
  bilhetes.set(id, { telefone, expiraEm: Date.now() + VALIDADE_BILHETE });
  return id;
}

function lerBilhete(id) {
  const b = bilhetes.get(String(id || ''));
  if (!b) return null;
  if (Date.now() > b.expiraEm) { bilhetes.delete(id); return null; }
  return b.telefone;
}

setInterval(() => {
  const agora = Date.now();
  for (const [id, b] of bilhetes) if (agora > b.expiraEm) bilhetes.delete(id);
}, 60000).unref();

/* ----------------------------- horários ---------------------------------- */

/** Mesmo número, escrito de jeitos diferentes. Oito dígitos finais bastam. */
function mesmoTelefone(a, b) {
  const x = String(a || '').replace(/\D/g, '');
  const y = String(b || '').replace(/\D/g, '');
  if (x.length < 8 || y.length < 8) return false;
  return x.slice(-8) === y.slice(-8);
}

/**
 * Todos os horários de hoje em que esta pessoa é esperada.
 *
 * Vem de `agenda.listaDoDia`, que já junta as duas origens: a grade fixa da
 * matrícula e as reservas feitas no app. Perguntar só aos agendamentos
 * deixaria de fora o mensalista, que treina toda terça às 18h e nunca reservou
 * nada — e ele é a maior parte de quem passa pelo tablet.
 */
function horariosDeHoje(telefone, data) {
  const lista = agenda.listaDoDia(data);
  const meus = [];
  for (const h of lista.horarios) {
    const eu = (h.alunos || []).find((a) => mesmoTelefone(a.telefone, telefone));
    if (eu) meus.push({ hora: h.hora, origem: eu.origem, agendamentoId: eu.id || null });
  }
  return meus.sort((a, b) => a.hora.localeCompare(b.hora));
}

/** O horário de hoje que está acontecendo agora, dentro da janela. */
function horarioDeAgora(meus, data, fuso) {
  const dentro = meus
    .map((h) => ({ ...h, faltam: agenda.minutosAte(data, h.hora, fuso) }))
    .filter((h) => h.faltam <= MINUTOS_ANTES && h.faltam >= -MINUTOS_DEPOIS)
    // Duas aulas na janela ao mesmo tempo é raro; a mais próxima do agora ganha.
    .sort((a, b) => Math.abs(a.faltam) - Math.abs(b.faltam));
  return dentro[0] || null;
}

/* ------------------------------ rotas ------------------------------------ */

/**
 * Quem tem telefone terminado nestes quatro dígitos.
 *
 * Devolve nome e bilhete. Um resultado só já vem com tudo que a próxima tela
 * precisa; vários, a pessoa toca no seu nome. Nenhum, a mensagem manda procurar
 * a recepção em vez de sugerir que o número está errado — pode ser que ela
 * ainda não tenha cadastro, e esse é o outro botão da tela inicial.
 */
rotas.post('/buscar', doTablet, comFreio(20), (req, res) => {
  const final = String(req.body.final || '').replace(/\D/g, '');
  if (final.length !== 4) {
    return res.status(400).json({ erro: 'Digite os 4 últimos dígitos do seu telefone.' });
  }

  const achados = store.alunosPorFinal(final);
  if (!achados.length) {
    return res.json({ alunos: [] });
  }

  res.json({
    alunos: achados.map((a) => ({
      bilhete: emitirBilhete(a.telefone),
      nome: a.nome || 'Sem nome',
    })),
  });
});

/**
 * Confirma a presença — só quando há aula agendada agora.
 *
 * Fora da janela não registra nada e diz o porquê, com os horários de hoje
 * quando existem. É a regra do estúdio: presença que não bate com o horário
 * marcado vira número errado na frequência, e o aluno descobre no fim do mês,
 * quando não dá mais para reconstruir o que aconteceu.
 */
rotas.post('/confirmar', doTablet, comFreio(30), (req, res) => {
  const telefone = lerBilhete(req.body.bilhete);
  if (!telefone) {
    return res.status(400).json({ erro: 'Sua escolha expirou. Digite os 4 dígitos de novo.' });
  }

  const aluno = store.aluno(telefone);
  if (!aluno) return res.status(404).json({ erro: 'Cadastro não encontrado.' });
  if (aluno.bloqueado) {
    return res.json({ ok: false, motivo: 'Seu acesso está suspenso. Fale com o estúdio.' });
  }

  const c = config.ler();
  const fuso = c.estudio.fuso;
  const data = agenda.hoje(fuso);
  const meus = horariosDeHoje(telefone, data);
  const agora = horarioDeAgora(meus, data, fuso);

  if (!agora) {
    const motivo = meus.length
      ? 'Seu check-in não bate com o horário agendado.'
      : 'Você não tem aula agendada para hoje.';
    return res.json({
      ok: false, motivo, nome: aluno.nome || null,
      horariosDeHoje: meus.map((h) => h.hora),
    });
  }

  const r = store.registrarPresenca({
    telefone,
    nome: aluno.nome,
    data,
    hora: agora.hora,
    agendamentoId: agora.agendamentoId,
    origem: 'totem',
  });

  const m = matriculas.porTelefone(telefone);
  console.log(`[totem] presença ${data} ${agora.hora} — ${aluno.nome || telefone}`
    + `${m ? '' : ' (sem matrícula)'}${r.repetida ? ' (repetida)' : ''}`);

  res.json({
    ok: true,
    nome: aluno.nome || null,
    hora: agora.hora,
    repetida: r.repetida,
  });
});

/**
 * Cadastro aberto no próprio tablet, sem código de confirmação.
 *
 * Sem código porque quem está digitando está dentro do estúdio, na frente de
 * alguém — o código no WhatsApp existe para provar que o número é seu quando
 * não há ninguém olhando, e aqui há.
 *
 * NÃO MARCA `ultimoAcesso`
 *   Isso mantém a próxima entrada no app como primeiro acesso, que é onde a
 *   pessoa escolhe os horários da semana. Sem grade ela não aparece em lista de
 *   presença nenhuma — e sem aparecer, não conseguiria confirmar presença
 *   aqui. Pedir a grade inteira de pé no tablet seria pior.
 */
rotas.post('/cadastro', doTablet, comFreio(10), (req, res) => {
  const c = config.ler();
  const telefone = rotasAgenda.normalizarTelefone(req.body.telefone);
  if (!telefone) {
    return res.status(400).json({ erro: 'Telefone inválido. Use DDD + número.' });
  }

  const nome = String(req.body.nome || '').trim().replace(/\s+/g, ' ');
  if (!rotasAgenda.nomeCompleto(nome)) {
    return res.status(400).json({ erro: 'Informe o nome completo: nome e sobrenome.' });
  }

  const aniversario = rotasAgenda.normalizarAniversario(req.body.aniversario);
  if (!aniversario) {
    return res.status(400).json({ erro: 'Aniversário inválido. Use dia e mês, como 07/03.' });
  }

  const existente = store.aluno(telefone);
  if (existente && existente.nome) {
    return res.status(409).json({
      erro: `Este telefone já tem cadastro no nome de ${existente.nome}.`,
    });
  }
  if (!existente && !c.acesso.cadastroAberto) {
    return res.status(403).json({
      erro: 'O estúdio está com o cadastro fechado. Fale com a recepção.',
    });
  }

  // Nome do Wellhub manda, como em todo o resto do sistema: se a ficha já tem
  // vínculo com o portal, o que a pessoa digitou aqui não sobrescreve.
  const doWellhub = rotasAgenda.nomeDoWellhub(telefone);

  const aluno = store.salvarAluno(telefone, {
    nome: doWellhub || nome,
    aniversario,
  });
  console.log(`[totem] cadastro aberto no tablet: ${aluno.nome} (${telefone}).`);

  res.json({
    ok: true,
    nome: aluno.nome,
    // A tela usa isto para mandar a pessoa escolher os horários no app.
    faltaGrade: true,
  });
});

module.exports = { rotas };
