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
const checkins = require('./checkins-store');
const alunosLogin = require('./agenda-store');
const aniversario = require('./aniversario');
const telefone = require('./telefone');
const frequencia = require('./frequencia');
const alertas = require('./alertas-frequencia');
const poller = require('./poller-portal');

module.exports = function criarRotas({ exigirLogin, exigirAdmin }) {
  const rotas = express.Router();
  rotas.use(exigirLogin, exigirAdmin);

  const hoje = () => agenda.hoje(config.ler().estudio.fuso);

  /**
   * Casa a matrícula com a ficha de login pelos 8 dígitos finais do telefone.
   * O mesmo número aparece ora com DDI, ora sem o nono dígito; exigir igualdade
   * literal deixaria as duas fichas separadas por causa de um '55'.
   */
  function fichaDeLogin(m) {
    const meu = String(m.telefone || '').replace(/\D/g, '');
    if (meu.length < 8) return null;
    return alunosLogin.listarAlunos().find((a) => {
      const dele = String(a.telefone || '').replace(/\D/g, '');
      return dele.length >= 8 && dele.slice(-8) === meu.slice(-8);
    }) || null;
  }

  /**
   * O nascimento agora se cadastra aqui, mas o app do aluno também pergunta a
   * data no primeiro acesso e a mostra em "Meus dados". Manter os dois lados
   * iguais evita o aluno ver uma data e você ver outra.
   *
   * A matrícula manda: se ela tem data, a ficha de login recebe. Só quando a
   * matrícula está vazia é que o caminho se inverte — assim o que o aluno já
   * preencheu no app não se perde ao aparecer nesta tela.
   */
  function sincronizarNascimento(m) {
    const login = fichaDeLogin(m);
    if (!login) return;
    if (m.aniversario && login.aniversario !== m.aniversario) {
      alunosLogin.salvarAluno(login.telefone, { aniversario: m.aniversario });
    } else if (!m.aniversario && login.aniversario) {
      store.atualizar(m.id, { aniversario: login.aniversario });
    }
  }

  /** Alunos com acesso ao app e nenhuma matrícula — ver detalhe em /acessos. */
  function acessosSoltos() {
    const matriculados = new Set(store.listar()
      .map((m) => telefone.normalizar(m.telefone))
      .filter(Boolean));
    return alunosLogin.listarAlunos()
      .filter((a) => !matriculados.has(a.telefone))
      .map((a) => ({
        telefone: a.telefone,
        telefoneFormatado: telefone.mostrar(a.telefone),
        nome: a.nome || null,
        bloqueado: Boolean(a.bloqueado),
        admin: config.ehAdmin(a.telefone),
        aniversarioFormatado: aniversario.mostrar(a.aniversario),
        criadoEm: a.criadoEm || null,
      }))
      .sort((x, y) => String(x.nome || '~').localeCompare(String(y.nome || '~'), 'pt-BR'));
  }

  /**
   * Estado do acesso ao app, que antes vivia na aba Alunos. Vem junto da ficha
   * porque é sempre a mesma pessoa: separar as duas telas obrigava a procurar o
   * aluno duas vezes, e o telefone editado num lado não chegava ao outro.
   */
  function acesso(m) {
    const login = fichaDeLogin(m);
    if (!login) return null;
    return {
      telefone: login.telefone,
      telefoneFormatado: telefone.mostrar(login.telefone),
      nome: login.nome || null,
      bloqueado: Boolean(login.bloqueado),
      admin: config.ehAdmin(login.telefone),
      criadoEm: login.criadoEm || null,
    };
  }

  function ficha(m) {
    const a = acesso(m);
    return {
      ...m,
      diasSemana: grade.diasPorSemana(m),
      precisaRevisar: Boolean((m.revisar || []).length),
      aniversarioFormatado: aniversario.mostrar(m.aniversario),
      temLogin: Boolean(a),
      acesso: a,
    };
  }

  /**
   * Espelha na ficha de login o que mudou na matrícula.
   *
   * Trocar o telefone é o caso delicado: ele é a CHAVE do cadastro de login, e
   * gravar o número novo sem mover a ficha criaria um segundo cadastro, deixando
   * os agendamentos e o histórico presos ao antigo. `trocarTelefone` move tudo
   * junto e derruba a sessão aberta — o aluno entra de novo com o número novo.
   *
   * @param anterior  a matrícula como estava ANTES do PUT
   */
  function espelharNoLogin(m, anterior) {
    const antes = telefone.normalizar(anterior && anterior.telefone);
    const agora = telefone.normalizar(m.telefone);

    if (antes && agora && antes !== agora && alunosLogin.aluno(antes)) {
      if (config.ehAdmin(antes)) {
        return { ok: false, motivo: 'Este número é de administrador. '
          + 'Ajuste a lista em Configurações antes de trocar.' };
      }
      const r = alunosLogin.trocarTelefone(antes, agora);
      if (!r.ok) return { ok: false, motivo: r.motivo };
    }

    const login = fichaDeLogin(m);
    if (!login) return { ok: true };

    // O nome que o aluno vê no app é o da ficha de login. Deixá-lo para trás
    // faria a tela dele mostrar o apelido da planilha depois do Wellhub já ter
    // corrigido o nome aqui.
    const campos = {};
    if (m.nome && login.nome !== m.nome) campos.nome = m.nome;
    if (m.aniversario && login.aniversario !== m.aniversario) campos.aniversario = m.aniversario;
    if (Object.keys(campos).length) alunosLogin.salvarAluno(login.telefone, campos);
    return { ok: true };
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
    if (req.query.acesso === 'suspensos') {
      lista = lista.filter((m) => (acesso(m) || {}).bloqueado);
    } else if (req.query.acesso === 'sem') {
      lista = lista.filter((m) => !acesso(m));
    } else if (req.query.acesso === 'com') {
      lista = lista.filter((m) => acesso(m));
    }
    if (busca) {
      lista = lista.filter((m) =>
        String(m.nome).toLocaleLowerCase('pt-BR').includes(busca) ||
        String(m.telefone || '').includes(busca));
    }

    // Puxa para a matrícula o que já existe na ficha de login. Roda na listagem
    // porque é a primeira tela que se abre — quem tinha data no app aparece
    // aqui já com ela, sem passo de importação.
    lista.forEach(sincronizarNascimento);

    const todas = store.listar().filter((m) => m.ativo);
    const acessos = todas.map(acesso);
    res.json({
      resumo: {
        ...store.resumo(),
        comAcesso: acessos.filter(Boolean).length,
        suspensos: acessos.filter((a) => a && a.bloqueado).length,
        acessosSoltos: acessosSoltos().length,
      },
      matriculas: lista.map(ficha),
    });
  });

  /* ----------------------------- frequência ------------------------------ *
   * Estas rotas vêm ANTES de '/:id' de propósito: '/frequencia' e '/checkins'
   * têm um segmento só e seriam capturadas pelo parâmetro, devolvendo
   * "Matrícula não encontrada" para um caminho que existe.
   * ---------------------------------------------------------------------- */

  /** Panorama: quem está em dia e quem deve treino na janela. */
  rotas.get('/frequencia', (req, res) => {
    const dias = Number(req.query.dias) > 0 ? Number(req.query.dias) : alertas.JANELA_DIAS;
    // Sem `vinculo` na querystring avalia só Wellhub, que é quem faz check-in.
    // `vinculo=todos` inclui mensalista, útil quando você registrar presença
    // deles por outro caminho.
    const vinculo = req.query.vinculo === 'todos' ? null : (req.query.vinculo || 'wellhub');
    const painel = alertas.montarPainel({ dias, vinculo, ate: req.query.ate || undefined });

    const filtro = String(req.query.situacao || '');
    const alunos = filtro === 'devendo'
      ? frequencia.devedores(painel)
      : (filtro ? painel.alunos.filter((a) => a.situacao === filtro) : painel.alunos);

    res.json({
      ...painel,
      alunos,
      checkins: checkins.resumo(),
      aviso: alertas.situacao(),
    });
  });

  /** Pré-visualiza o aviso diário; ?enviar=1 dispara na hora. */
  rotas.post('/frequencia/aviso', async (req, res) => {
    try {
      const r = await alertas.rodar({
        avisar: req.query.enviar === '1' || req.body.enviar === true,
        mesmoSemDevedores: true,
        dias: Number(req.body.dias) || undefined,
      });
      res.json(r);
    } catch (e) { res.status(500).json({ erro: e.message }); }
  });

  /** Cobra um aluno pelo WhatsApp. Texto livre opcional. */
  rotas.post('/frequencia/cobrar', async (req, res) => {
    const r = await alertas.cobrar(String(req.body.matriculaId || ''), req.body.texto);
    if (!r.ok) return res.status(400).json({ erro: r.motivo, texto: r.texto || null });
    res.json(r);
  });

  /* ------------------------------ check-ins ------------------------------ */

  rotas.get('/checkins', (req, res) => {
    res.json({
      resumo: checkins.resumo(),
      checkins: checkins.listar({
        de: req.query.de || undefined,
        ate: req.query.ate || undefined,
        matriculaId: req.query.matriculaId || undefined,
        semVinculo: req.query.semVinculo === '1',
        limite: Number(req.query.limite || 200),
      }),
    });
  });

  /** Puxa a lista de validados do portal agora, sem esperar o ciclo de 15 min. */
  rotas.post('/checkins/sincronizar', async (_req, res) => {
    try {
      const rel = await poller.rodarUmaVez({ origem: 'manual', avisar: false });
      res.json({
        ok: !rel.erro,
        erro: rel.erro,
        validados: rel.validados,
        registrados: rel.registrados,
        resumo: checkins.resumo(),
      });
    } catch (e) { res.status(500).json({ erro: e.message }); }
  });

  /** Liga um check-in órfão a um aluno — e o Wellhub ID junto, para o futuro. */
  rotas.post('/checkins/:id/vincular', (req, res) => {
    const r = checkins.vincular(req.params.id, String(req.body.matriculaId || ''));
    if (!r.ok) return res.status(400).json({ erro: r.motivo });
    res.json(r);
  });

  rotas.post('/checkins/:id/desvincular', (req, res) => {
    const r = checkins.desvincular(req.params.id);
    if (!r.ok) return res.status(404).json({ erro: r.motivo });
    res.json(r);
  });

  /** Aplica em todas as fichas o nome que o Wellhub usa hoje. */
  rotas.post('/checkins/aplicar-nomes', (_req, res) => {
    res.json(checkins.aplicarNomesDoPortal());
  });

  /** Reprocessa os órfãos depois de cadastrar ou corrigir alunos. */
  rotas.post('/checkins/revincular', (_req, res) => {
    res.json(checkins.revincularOrfaos());
  });

  rotas.get('/:id', (req, res) => {
    const m = store.porId(req.params.id);
    if (!m) return res.status(404).json({ erro: 'Matrícula não encontrada.' });
    sincronizarNascimento(m);
    const dias = alertas.JANELA_DIAS;
    const ate = hoje();
    // Do dia 1º: `frequencia.avaliar` trunca a janela no mês e ainda calcula o
    // acumulado do ciclo, que precisa das exceções do mês inteiro.
    const de = frequencia.inicioDoMes(ate);
    res.json({
      ...ficha(m),
      proximas: grade.proximasDaMatricula(
        m, store.excecoes({ matriculaId: m.id }), { de: ate, dias: 21 }),
      frequencia: frequencia.avaliar(
        m, checkins.datasDaMatricula(m.id),
        store.excecoes({ matriculaId: m.id, de, ate }), { dias, ate }),
      checkins: checkins.listar({ matriculaId: m.id, limite: 60 }),
    });
  });

  rotas.post('/', (req, res) => {
    const r = store.criar(req.body || {});
    if (!r.ok) return res.status(400).json({ erro: r.motivo });
    sincronizarNascimento(r.matricula);
    res.status(201).json(ficha(r.matricula));
  });

  rotas.put('/:id', (req, res) => {
    // Cópia do estado anterior: depois do `atualizar` o objeto já é o novo, e o
    // telefone antigo — a chave da ficha de login — teria se perdido.
    const antes = { ...(store.porId(req.params.id) || {}) };

    const r = store.atualizar(req.params.id, req.body || {});
    if (!r.ok) return res.status(400).json({ erro: r.motivo });

    const espelho = espelharNoLogin(r.matricula, antes);
    if (!espelho.ok) {
      // Desfaz o telefone na matrícula: deixá-lo mudado aqui e parado lá é o
      // pior dos mundos — as duas fichas apontariam para números diferentes.
      store.atualizar(req.params.id, { telefone: antes.telefone || '' });
      return res.status(409).json({ erro: espelho.motivo });
    }

    sincronizarNascimento(r.matricula);
    res.json(ficha(r.matricula));
  });

  /* ------------------------- acesso ao app ------------------------------- */
  /* Era a aba Alunos. Vive na matrícula porque é a mesma pessoa: o cadastro de
     login guarda telefone, suspensão e sessão; a matrícula guarda quem treina.
     Um aluno sem telefone simplesmente não tem este bloco. */

  /** Suspende ou reativa o acesso ao app. */
  rotas.post('/:id/acesso', (req, res) => {
    const m = store.porId(req.params.id);
    if (!m) return res.status(404).json({ erro: 'Matrícula não encontrada.' });
    const login = fichaDeLogin(m);
    if (!login) return res.status(400).json({ erro: 'Este aluno não tem acesso ao app.' });

    if (req.body.bloqueado === undefined) {
      return res.status(400).json({ erro: 'Informe bloqueado=true ou false.' });
    }
    const bloqueado = Boolean(req.body.bloqueado);
    if (bloqueado && config.ehAdmin(login.telefone)) {
      return res.status(400).json({
        erro: 'Este número é de administrador. Remova da lista em Configurações antes de suspender.',
      });
    }
    alunosLogin.salvarAluno(login.telefone, { bloqueado });
    res.json(ficha(store.porId(m.id)));
  });

  /**
   * Apaga o cadastro de login. A matrícula continua: o aluno segue na grade,
   * só perde o acesso ao app — que é diferente de sair do estúdio.
   */
  rotas.delete('/:id/acesso', (req, res) => {
    const m = store.porId(req.params.id);
    if (!m) return res.status(404).json({ erro: 'Matrícula não encontrada.' });
    const login = fichaDeLogin(m);
    if (!login) return res.status(400).json({ erro: 'Este aluno não tem acesso ao app.' });
    if (config.ehAdmin(login.telefone)) {
      return res.status(400).json({ erro: 'Remova da lista de administradores primeiro.' });
    }
    alunosLogin.removerAluno(login.telefone);
    res.json(ficha(store.porId(m.id)));
  });

  /* --------------------- acessos sem matrícula --------------------------- */
  /* Quem entrou no app e não está na base do estúdio. Antes eram só mais uma
     linha na aba Alunos; sem uma tela para eles, ninguém mais conseguiria
     suspender ou apagar esses cadastros. */

  rotas.get('/acessos/soltos', (_req, res) => {
    res.json({ acessos: acessosSoltos() });
  });

  /** Cria a matrícula a partir de um cadastro de login já existente. */
  rotas.post('/acessos/:telefone/matricular', (req, res) => {
    const tel = telefone.normalizar(req.params.telefone);
    if (!tel) return res.status(400).json({ erro: 'Telefone inválido.' });
    const login = alunosLogin.aluno(tel);
    if (!login) return res.status(404).json({ erro: 'Cadastro de acesso não encontrado.' });

    const r = store.criar({
      nome: String(req.body.nome || login.nome || '').trim(),
      telefone: tel,
      aniversario: login.aniversario || undefined,
      vinculo: req.body.vinculo || 'mensalista',
      grade: [],
    });
    if (!r.ok) return res.status(400).json({ erro: r.motivo });
    res.status(201).json(ficha(r.matricula));
  });

  rotas.post('/acessos/:telefone/suspender', (req, res) => {
    const tel = telefone.normalizar(req.params.telefone);
    if (!tel || !alunosLogin.aluno(tel)) {
      return res.status(404).json({ erro: 'Cadastro de acesso não encontrado.' });
    }
    const bloqueado = req.body.bloqueado === undefined ? true : Boolean(req.body.bloqueado);
    if (bloqueado && config.ehAdmin(tel)) {
      return res.status(400).json({ erro: 'Este número é de administrador.' });
    }
    alunosLogin.salvarAluno(tel, { bloqueado });
    res.json({ ok: true, acessos: acessosSoltos() });
  });

  rotas.delete('/acessos/:telefone', (req, res) => {
    const tel = telefone.normalizar(req.params.telefone);
    if (!tel || !alunosLogin.aluno(tel)) {
      return res.status(404).json({ erro: 'Cadastro de acesso não encontrado.' });
    }
    if (config.ehAdmin(tel)) {
      return res.status(400).json({ erro: 'Remova da lista de administradores primeiro.' });
    }
    alunosLogin.removerAluno(tel);
    res.json({ ok: true, acessos: acessosSoltos() });
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
