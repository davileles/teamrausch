'use strict';

/**
 * app/src/rotas-matriculas.js — davileles/teamrausch
 *
 * Endpoints do cadastro interno e da grade fixa. Tudo aqui é de administrador:
 * hoje nenhum dos alunos importados tem telefone, então ninguém entra no app
 * por esta base — ela é operada por você, pela tela.
 *
 * Montado em `rotas-agenda.js` sob /agenda-api/matriculas, reaproveitando os
 * middlewares de sessão que já existem lá.
 */

const express = require('express');
const store = require('./matriculas-store');
const grade = require('./grade');
const config = require('./config');
const agenda = require('./agenda');

module.exports = function criarRotas({ exigirLogin, exigirAdmin }) {
  const rotas = express.Router();
  rotas.use(exigirLogin, exigirAdmin);

  const hoje = () => agenda.hoje(config.ler().estudio.fuso);

  function ficha(m) {
    return {
      ...m,
      diasSemana: grade.diasPorSemana(m),
      precisaRevisar: Boolean((m.revisar || []).length),
    };
  }

  /* ------------------------------ cadastro ------------------------------- */

  rotas.get('/', (req, res) => {
    const busca = String(req.query.busca || '').trim().toLocaleLowerCase('pt-BR');
    const situacao = String(req.query.situacao || 'ativos');   // ativos | inativos | todos
    const vinculo = String(req.query.vinculo || '');

    let lista = store.listar();
    if (situacao === 'ativos') lista = lista.filter((m) => m.ativo);
    else if (situacao === 'inativos') lista = lista.filter((m) => !m.ativo);
    if (vinculo) lista = lista.filter((m) => m.vinculo === vinculo);
    if (req.query.revisar === '1') lista = lista.filter((m) => (m.revisar || []).length);
    if (req.query.semTelefone === '1') lista = lista.filter((m) => !m.telefone);
    if (busca) {
      lista = lista.filter((m) =>
        String(m.nome).toLocaleLowerCase('pt-BR').includes(busca) ||
        String(m.telefone || '').includes(busca));
    }

    res.json({ resumo: store.resumo(), matriculas: lista.map(ficha) });
  });

  rotas.get('/:id', (req, res) => {
    const m = store.porId(req.params.id);
    if (!m) return res.status(404).json({ erro: 'Matrícula não encontrada.' });
    res.json({
      ...ficha(m),
      proximas: grade.proximasDaMatricula(
        m, store.excecoes({ matriculaId: m.id }), { de: hoje(), dias: 21 }),
    });
  });

  rotas.post('/', (req, res) => {
    const r = store.criar(req.body || {});
    if (!r.ok) return res.status(400).json({ erro: r.motivo });
    res.status(201).json(ficha(r.matricula));
  });

  rotas.put('/:id', (req, res) => {
    const r = store.atualizar(req.params.id, req.body || {});
    if (!r.ok) return res.status(400).json({ erro: r.motivo });
    res.json(ficha(r.matricula));
  });

  /** Padrão é inativar (preserva histórico). ?remover=1 apaga de vez. */
  rotas.delete('/:id', (req, res) => {
    const r = req.query.remover === '1'
      ? store.remover(req.params.id)
      : store.inativar(req.params.id);
    if (!r.ok) return res.status(404).json({ erro: r.motivo });
    res.json({ ok: true, removida: req.query.remover === '1' });
  });

  /* -------------------------------- grade -------------------------------- */

  /** Agenda projetada de um dia: quem tem aula, em que horário. */
  rotas.get('/grade/dia', (req, res) => {
    const data = String(req.query.data || hoje());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
      return res.status(400).json({ erro: 'Data inválida.' });
    }
    const matriculas = store.listar();
    const excecoes = store.excecoes({ de: data, ate: data });
    res.json({
      data,
      porExtenso: agenda.porExtenso(data),
      diaDaSemana: grade.diaDaSemana(data),
      hoje: hoje(),
      horarios: grade.agendaPorHorario(matriculas, data, excecoes),
      total: grade.agendaDoDia(matriculas, data, excecoes).length,
    });
  });

  /**
   * Mapa de lotação da semana — para enxergar os horários cheios de uma vez.
   *
   * `naAgenda` diz se aquele horário da grade também existe na aba Agendar.
   * Sem isso, um horário como 06:40 ficaria invisível: os alunos têm aula, mas
   * a agenda nunca o oferece e a lotação dele não aparece em lugar nenhum.
   */
  rotas.get('/grade/ocupacao', (_req, res) => {
    const c = config.ler();
    const capacidadePadrao = Number(c.agenda.capacidadePadrao) || 0;
    const slots = grade.ocupacaoSemanal(store.listar()).map((s) => {
      const doDia = c.agenda.horarios[agenda.DIAS[s.dia]] || [];
      const naAgenda = doDia.find((x) => x.hora === s.hora) || null;
      return {
        ...s,
        naAgenda: Boolean(naAgenda),
        capacidade: naAgenda ? (Number(naAgenda.capacidade) || capacidadePadrao) : null,
      };
    });
    res.json({ slots, foraDaAgenda: slots.filter((s) => !s.naAgenda).length });
  });

  /* ------------------------------ exceções ------------------------------- */

  rotas.get('/excecoes/lista', (req, res) => {
    res.json(store.excecoes({
      de: req.query.de || hoje(),
      ate: req.query.ate || undefined,
      matriculaId: req.query.matriculaId || undefined,
    }));
  });

  /** Desmarcar uma aula da grade ou encaixar uma extra num dia específico. */
  rotas.post('/excecoes', (req, res) => {
    const r = store.registrarExcecao({
      matriculaId: String(req.body.matriculaId || ''),
      data: String(req.body.data || ''),
      tipo: String(req.body.tipo || ''),
      hora: req.body.hora ? String(req.body.hora) : null,
      motivo: req.body.motivo,
    });
    if (!r.ok) return res.status(400).json({ erro: r.motivo });
    res.status(201).json(r.excecao);
  });

  rotas.delete('/excecoes/:id', (req, res) => {
    const r = store.apagarExcecao(req.params.id);
    if (!r.ok) return res.status(404).json({ erro: r.motivo });
    res.json({ ok: true });
  });

  /* ---------------------------- manutenção ------------------------------- */

  rotas.post('/importar', (req, res) => {
    const corpo = req.body || {};
    const lista = Array.isArray(corpo) ? corpo : corpo.matriculas;
    const r = store.importar(lista, { substituir: corpo.substituir === true });
    if (!r.ok) return res.status(409).json({ erro: r.motivo });
    res.json(r);
  });

  rotas.get('/estado/backup', (_req, res) => {
    res.json({ ...store.backup.situacao(), resumo: store.resumo() });
  });

  return rotas;
};
