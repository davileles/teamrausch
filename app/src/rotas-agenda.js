'use strict';

const express = require('express');
const crypto = require('crypto');
const config = require('./config');
const store = require('./agenda-store');
const agenda = require('./agenda');
const matriculas = require('./matriculas-store');
const grade = require('./grade');
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

/* ------------------------- senha do administrador ------------------------- */

/**
 * Guardamos scrypt com sal aleatório, nunca a senha em texto. Se o config.json
 * vazar (backup, log, alguém com acesso ao volume), o que sai dali não serve
 * para entrar.
 */
function criarSenha(texto) {
  const sal = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(texto), sal, 64).toString('hex');
  return { sal, hash, criadaEm: new Date().toISOString() };
}

function senhaConfere(texto, guardada) {
  if (!guardada || !guardada.sal || !guardada.hash) return false;
  const tentativa = crypto.scryptSync(String(texto || ''), guardada.sal, 64);
  const esperado = Buffer.from(guardada.hash, 'hex');
  if (tentativa.length !== esperado.length) return false;
  return crypto.timingSafeEqual(tentativa, esperado);
}

/** O administrador entra por senha quando existe uma senha definida. */
function usaSenha(telefone) {
  return ehAdmin(telefone) && Boolean(config.ler().acesso.senhaAdmin);
}

// Freio contra tentativa em série. Fica em memória: reiniciar o serviço zera,
// o que é aceitável porque reiniciar não é algo que um atacante controla.
const falhas = new Map();
const MAX_FALHAS = 5;
const CASTIGO_MS = 10 * 60000;

function bloqueado(telefone) {
  const f = falhas.get(telefone);
  if (!f) return 0;
  if (Date.now() > f.ate) { falhas.delete(telefone); return 0; }
  return f.contagem >= MAX_FALHAS ? Math.ceil((f.ate - Date.now()) / 60000) : 0;
}

function registrarFalha(telefone) {
  const f = falhas.get(telefone) || { contagem: 0, ate: 0 };
  f.contagem += 1;
  f.ate = Date.now() + CASTIGO_MS;
  falhas.set(telefone, f);
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

  // Administrador com senha definida: não há código nenhum, é senha.
  if (usaSenha(telefone)) {
    return res.json({
      enviado: true,
      canal: 'senha',
      precisaDeSenha: true,
      telefone: mostrarTelefone(telefone),
      precisaDeNome: !cadastrado || !cadastrado.nome,
      precisaDeAniversario: !cadastrado || !cadastrado.aniversario,
    });
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

  if (usaSenha(telefone)) {
    const minutos = bloqueado(telefone);
    if (minutos) {
      return res.status(429).json({ erro: `Senha errada vezes demais. Tente em ${minutos} min.` });
    }
    if (!senhaConfere(req.body.senha, c.acesso.senhaAdmin)) {
      registrarFalha(telefone);
      console.warn(`[acesso] senha incorreta para ${telefone}.`);
      return res.status(401).json({ erro: 'Senha incorreta.' });
    }
    falhas.delete(telefone);
  } else if (!entraSemCodigo(telefone)) {
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

/* ------------------------------ perfil ----------------------------------- */

/**
 * Números para a aba Meus dados.
 *
 * Importante: contamos horários RESERVADOS que já passaram, não presença
 * confirmada. Quem reservou e não apareceu entra na conta. Enquanto o
 * check-in do Wellhub não estiver ligado, é o melhor que temos — e a tela
 * diz isso ao aluno em vez de fingir precisão.
 */
function numerosDoAluno(telefone) {
  const c = config.ler();
  const hoje = agenda.hoje(c.estudio.fuso);
  const historico = store.historicoDoAluno(telefone);

  const passados = historico.filter((a) => a.data < hoje);
  const futuros = historico.filter((a) => a.data >= hoje);

  const mes = hoje.slice(0, 7);
  const noMes = passados.filter((a) => a.data.startsWith(mes)).length;

  // Dias distintos: dois horários no mesmo dia contam como uma ida.
  const diasDistintos = [...new Set(passados.map((a) => a.data))];

  // Semanas seguidas com pelo menos uma ida, contando de trás para frente a
  // partir da semana atual. Semanas é a unidade certa aqui: o estúdio não
  // abre fim de semana, então "dias seguidos" travaria em 5 por definição.
  const semanaDe = (data) => {
    const d = new Date(`${data}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - d.getUTCDay());   // volta para o domingo
    return d.toISOString().slice(0, 10);
  };
  const semanas = new Set(diasDistintos.map(semanaDe));
  let sequencia = 0;
  const cursor = new Date(`${semanaDe(hoje)}T12:00:00Z`);
  // A semana corrente só conta se já houve ida; senão a sequência não quebra
  // por ainda ser segunda de manhã.
  if (!semanas.has(cursor.toISOString().slice(0, 10))) {
    cursor.setUTCDate(cursor.getUTCDate() - 7);
  }
  while (semanas.has(cursor.toISOString().slice(0, 10))) {
    sequencia += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 7);
  }

  // Horário mais repetido.
  const porHora = {};
  for (const a of passados) porHora[a.hora] = (porHora[a.hora] || 0) + 1;
  const favorito = Object.entries(porHora).sort((x, y) => y[1] - x[1])[0];

  const primeira = passados[0] ? passados[0].data : null;

  // Conquistas: as já alcançadas e a próxima, com quanto falta.
  const marcos = (c.conquistas || [])
    .filter((m) => Number(m.aulas) > 0)
    .sort((x, y) => Number(x.aulas) - Number(y.aulas));
  const alcancadas = marcos.filter((m) => passados.length >= Number(m.aulas));
  const proxima = marcos.find((m) => passados.length < Number(m.aulas)) || null;

  return {
    conquistas: alcancadas,
    proximaConquista: proxima
      ? { ...proxima, faltam: Number(proxima.aulas) - passados.length }
      : null,
    total: passados.length,
    dias: diasDistintos.length,
    noMes,
    semanasSeguidas: sequencia,
    horarioFavorito: favorito ? favorito[0] : null,
    vezesNoFavorito: favorito ? favorito[1] : 0,
    primeiraVez: primeira,
    primeiraVezPorExtenso: primeira ? agenda.porExtenso(primeira) : null,
    proximos: futuros.length,
  };
}

rotas.get('/perfil', exigirLogin, (req, res) => {
  res.json({
    nome: req.aluno.nome,
    telefone: mostrarTelefone(req.aluno.telefone),
    aniversario: mostrarAniversario(req.aluno.aniversario),
    desde: req.aluno.criadoEm || null,
    numeros: numerosDoAluno(req.aluno.telefone),
  });
});

/**
 * O aluno corrige o próprio nome e aniversário. O telefone fica de fora de
 * propósito: é a chave do cadastro e a credencial de entrada, então só o
 * estúdio troca, pela aba Alunos.
 */
rotas.put('/perfil', exigirLogin, (req, res) => {
  const campos = {};

  if (req.body.nome !== undefined) {
    const nome = String(req.body.nome).trim();
    if (!nome) return res.status(400).json({ erro: 'Informe como você quer ser chamado.' });
    if (nome.length > 60) return res.status(400).json({ erro: 'Nome muito longo.' });
    campos.nome = nome;
  }

  if (req.body.aniversario !== undefined) {
    const limpo = normalizarAniversario(req.body.aniversario);
    if (!limpo) return res.status(400).json({ erro: 'Aniversário inválido. Use dia e mês, como 07/03.' });
    campos.aniversario = limpo;
  }

  const aluno = store.salvarAluno(req.aluno.telefone, campos);
  res.json({
    nome: aluno.nome,
    telefone: mostrarTelefone(aluno.telefone),
    aniversario: mostrarAniversario(aluno.aniversario),
    desde: aluno.criadoEm || null,
    numeros: numerosDoAluno(aluno.telefone),
  });
});

/* ----------------------------- agenda ------------------------------------ */

/* ------------------------------ avisos ----------------------------------- */

/**
 * As regras que o aluno precisa saber, escritas a partir da própria
 * configuração. Assim não existe o texto explicando uma coisa e o sistema
 * fazendo outra — mudou a regra em Negócio, o texto muda junto.
 *
 * O texto muda também conforme quem lê. Para quem tem matrícula, a agenda não
 * é um lugar onde se escolhe horário do zero: os dias dele já vêm marcados, e
 * o que ele precisa saber é como desmarcar e quando dá para encaixar outro.
 * Explicar reserva para quem nunca vai reservar só atrapalha.
 */
function regrasEmTexto(matricula) {
  const c = config.ler();
  const a = c.agenda;
  const linhas = [];
  const frequencia = matricula ? grade.diasPorSemana(matricula) : 0;

  if (matricula) {
    linhas.push('Os horários da sua matrícula já vêm marcados — não precisa reservar nada.');
  }

  const dias = Number(a.diasAntecedencia) || 0;
  const janela = dias === 0
    ? 'só para hoje'
    : dias === 1 ? 'para hoje e amanhã' : `para hoje e os próximos ${dias} dias`;

  if (matricula) {
    linhas.push(`Quer treinar num horário diferente do seu? Reserve, se houver vaga — a agenda abre ${janela}.`);
  } else {
    linhas.push(`A agenda abre ${janela}.`);
  }

  if (frequencia > 0 && a.respeitarFrequencia !== false) {
    linhas.push(`Sua matrícula é de ${frequencia}x por semana: esse é o total de dias que dá para marcar.`);
  }

  const limite = Number(a.limitePorDia) || 0;
  if (limite === 1) linhas.push('É um horário por dia.');
  else if (limite > 1) linhas.push(`Dá para ficar em até ${limite} horários no mesmo dia.`);

  const fecha = Number(a.minutosAntesDeFechar) || 0;
  if (fecha > 0) linhas.push(`O horário fecha ${agenda.emTextoDeTempo(fecha)} antes de começar.`);

  if (a.permitirCancelar) {
    const canc = Number(a.minutosParaCancelar) || 0;
    const prazo = canc > 0 ? `até ${agenda.emTextoDeTempo(canc)} antes` : 'a qualquer momento antes do horário';
    linhas.push(matricula
      ? `Não vai poder ir? Toque em "Não vou" ${prazo} e seu lugar volta para a agenda.`
      : `Você pode cancelar ${prazo}.`);
  } else {
    linhas.push('Cancelamento pelo app está desligado — fale com o estúdio.');
  }

  if (!matricula && a.contarMatriculasNaLotacao !== false) {
    linhas.push('As vagas já descontam quem tem aula fixa naquele horário.');
  }

  return linhas;
}

/** O alerta vale enquanto tiver texto e não tiver passado da data limite. */
function alertaAtivo() {
  const c = config.ler();
  const texto = String(c.estudio.alerta || '').trim();
  if (!texto) return null;

  const ate = String(c.estudio.alertaAte || '').trim();
  if (ate && agenda.hoje(c.estudio.fuso) > ate) return null;

  return {
    texto,
    // Muda quando o texto muda: é assim que a tela sabe que é um aviso novo
    // e mostra o popup de novo para quem já tinha fechado o anterior.
    id: crypto.createHash('sha256').update(texto).digest('hex').slice(0, 16),
  };
}

/**
 * "Meus horários" junta o que a pessoa reservou no app com as aulas da
 * matrícula dela. Antes só a reserva aparecia — quem tem grade fixa e nunca
 * reserva via a tela dizer que não tinha horário nenhum.
 *
 * A grade não tem fim, então projetamos duas semanas: é o suficiente para a
 * pessoa conferir a própria semana sem virar uma lista infinita.
 */
function meusHorarios(telefone, hoje) {
  const c = config.ler();
  const minha = matriculas.porTelefone(telefone);
  const lista = store.doAluno(telefone, hoje).map((a) => ({
    id: a.id, data: a.data, hora: a.hora, origem: 'reserva',
  }));

  if (minha) {
    const jaTem = new Set(lista.map((a) => `${a.data}|${a.hora}`));
    for (const x of grade.proximasDaMatricula(
      minha, matriculas.excecoes({ matriculaId: minha.id, de: hoje }), { de: hoje, dias: 14 })) {
      if (jaTem.has(`${x.data}|${x.hora}`)) continue;
      lista.push({ id: null, data: x.data, hora: x.hora, origem: x.origem });
    }
  }

  // As mesmas regras que valem na aba Agendar. Sem isto esta lista mostrava um
  // botão de cancelar que o servidor ia recusar, e as duas telas discordavam
  // sobre a mesma aula.
  const minimo = Number(c.agenda.minutosParaCancelar || 0);
  const abertas = new Set(agenda.datasAbertas());

  return lista
    .sort((a, b) => (a.data + a.hora).localeCompare(b.data + b.hora))
    .map((a) => {
      const aTempo = Boolean(c.agenda.permitirCancelar) &&
        agenda.minutosAte(a.data, a.hora, c.estudio.fuso) >= minimo;
      return {
        ...a,
        porExtenso: agenda.porExtenso(a.data),
        podeLargar: aTempo,
        // Trocar acontece na aba Agendar, que só enxerga os dias abertos.
        podeTrocar: aTempo && abertas.has(a.data),
        motivoTravado: aTempo ? null : (c.agenda.permitirCancelar
          ? `Trocar ou desmarcar só até ${agenda.emTextoDeTempo(minimo)} antes.`
          : 'O estúdio não abriu cancelamento e troca pelo app.'),
      };
    });
}

rotas.get('/agenda', exigirLogin, (req, res) => {
  const hoje = agenda.hoje(config.ler().estudio.fuso);
  res.json({
    dias: agenda.montarDias(req.aluno.telefone),
    meus: meusHorarios(req.aluno.telefone, hoje),
    matricula: agenda.minhaMatricula(req.aluno.telefone, hoje),
    recado: config.ler().estudio.recado || '',
    regras: regrasEmTexto(matriculas.porTelefone(req.aluno.telefone)),
    alerta: alertaAtivo(),
  });
});

rotas.post('/agenda/reservar', exigirLogin, (req, res) => {
  const { data, hora } = req.body;
  const r = agenda.reservar(req.aluno, String(data || ''), String(hora || ''));
  if (!r.ok) return res.status(409).json({ erro: r.motivo });
  res.json({ ok: true, agendamento: r.agendamento });
});

/**
 * Cancelar aceita as duas naturezas de horário:
 *   { id }          → reserva feita no app.
 *   { data, hora }  → aula da matrícula, que vira uma exceção do dia.
 * A tela não precisa saber a diferença: manda o que tem.
 */
rotas.post('/agenda/cancelar', exigirLogin, (req, res) => {
  const id = String(req.body.id || '');
  const r = id
    ? agenda.cancelar(req.aluno, id, req.admin)
    : agenda.desmarcarFixa(req.aluno, String(req.body.data || ''), String(req.body.hora || ''));
  if (!r.ok) return res.status(409).json({ erro: r.motivo });
  res.json({ ok: true });
});

/**
 * Trocar de horário. Vai num pedido só, não em cancelar + reservar: se o
 * destino não der, a aula original continua de pé.
 */
rotas.post('/agenda/trocar', exigirLogin, (req, res) => {
  const { de, para } = req.body || {};
  const r = agenda.trocar(req.aluno, de, para);
  if (!r.ok) return res.status(409).json({ erro: r.motivo });
  res.json({ ok: true });
});

/* --------------------------- administração ------------------------------- */

rotas.get('/admin/dia', exigirLogin, exigirAdmin, (req, res) => {
  const data = String(req.query.data || agenda.hoje(config.ler().estudio.fuso));
  res.json(agenda.listaDoDia(data));
});

rotas.get('/admin/config', exigirLogin, exigirAdmin, (_req, res) => {
  res.json(config.paraAdmin());
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

  // A senha nunca chega pronta do navegador; só o texto novo, em campo próprio.
  if (novo.acesso) delete novo.acesso.senhaAdmin;

  if (novo.novaSenhaAdmin !== undefined) {
    const texto = String(novo.novaSenhaAdmin);
    if (texto === '') {
      novo.acesso = { ...(novo.acesso || {}), senhaAdmin: null };
      console.warn('[acesso] senha de administrador removida; volta a valer o código.');
    } else if (texto.length < 6) {
      return res.status(400).json({ erro: 'A senha precisa ter pelo menos 6 caracteres.' });
    } else {
      novo.acesso = { ...(novo.acesso || {}), senhaAdmin: criarSenha(texto) };
    }
  }
  delete novo.novaSenhaAdmin;

  if (novo.conquistas !== undefined) {
    if (!Array.isArray(novo.conquistas)) {
      return res.status(400).json({ erro: 'Lista de conquistas inválida.' });
    }
    const limpas = [];
    for (const m of novo.conquistas) {
      const aulas = Number(m.aulas);
      const titulo = String(m.titulo || '').trim();
      if (!Number.isInteger(aulas) || aulas < 1 || aulas > 100000) {
        return res.status(400).json({ erro: `Número de aulas inválido: ${m.aulas}` });
      }
      if (!titulo) return res.status(400).json({ erro: `Dê um nome à conquista de ${aulas} aulas.` });
      limpas.push({ aulas, titulo: titulo.slice(0, 40), emoji: String(m.emoji || '').trim().slice(0, 4) });
    }
    // Sem repetir a mesma quantidade: duas conquistas no mesmo número
    // apareceriam juntas e ninguém entenderia por quê.
    const vistos = new Set();
    for (const m of limpas) {
      if (vistos.has(m.aulas)) {
        return res.status(400).json({ erro: `Há duas conquistas com ${m.aulas} aulas.` });
      }
      vistos.add(m.aulas);
    }
    novo.conquistas = limpas.sort((x, y) => x.aulas - y.aulas);
  }

  // Avisos de check-in: listas de e-mail e de telefone, com repetidos removidos.
  if (novo.avisos !== undefined) {
    const a = novo.avisos || {};

    if (a.emails !== undefined) {
      if (!Array.isArray(a.emails)) {
        return res.status(400).json({ erro: 'Lista de e-mails inválida.' });
      }
      const limpos = [];
      for (const bruto of a.emails) {
        const email = String(bruto || '').trim().toLowerCase();
        if (!email) continue;
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
          return res.status(400).json({ erro: `E-mail inválido: ${email}` });
        }
        limpos.push(email.slice(0, 120));
      }
      a.emails = [...new Set(limpos)];
    }

    if (a.telefones !== undefined) {
      if (!Array.isArray(a.telefones)) {
        return res.status(400).json({ erro: 'Lista de telefones inválida.' });
      }
      const limpos = [];
      for (const bruto of a.telefones) {
        if (!String(bruto || '').trim()) continue;
        const tel = normalizarTelefone(bruto);
        if (!tel) {
          return res.status(400).json({ erro: `Telefone inválido: ${bruto}. Use DDD + 9 dígitos.` });
        }
        limpos.push(tel);
      }
      a.telefones = [...new Set(limpos)];
    }

    if (a.checkinConfirmado !== undefined) a.checkinConfirmado = Boolean(a.checkinConfirmado);
    novo.avisos = a;
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

  config.gravar(novo);
  res.json(config.paraAdmin());
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
  let telefone = normalizarTelefone(req.params.telefone);
  if (!telefone) return res.status(400).json({ erro: 'Telefone inválido.' });

  // Trocar o telefone vem primeiro: os outros campos são gravados na ficha nova.
  if (req.body.novoTelefone !== undefined && String(req.body.novoTelefone).trim()) {
    const novo = normalizarTelefone(req.body.novoTelefone);
    if (!novo) return res.status(400).json({ erro: 'Novo telefone inválido. Use DDD + 9 dígitos.' });
    if (novo !== telefone) {
      if (ehAdmin(telefone)) {
        return res.status(400).json({
          erro: 'Este número é de administrador. Ajuste a lista em Configurações antes de trocar.',
        });
      }
      const r = store.trocarTelefone(telefone, novo);
      if (!r.ok) return res.status(409).json({ erro: r.motivo });
      telefone = novo;
    }
  }

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
  const aluno = store.salvarAluno(telefone, campos);
  res.json({
    ...aluno,
    telefoneFormatado: mostrarTelefone(aluno.telefone),
    aniversarioFormatado: mostrarAniversario(aluno.aniversario),
  });
});

rotas.get('/admin/backup', exigirLogin, exigirAdmin, (_req, res) => {
  res.json(store.backup.situacao());
});

/* --------------------- cadastro interno e grade fixa ---------------------- */
// Base própria, com chave por id em vez de telefone: veio da planilha do
// estúdio e a maioria dos alunos ainda não tem número cadastrado. Montada aqui
// para reaproveitar a sessão e a checagem de administrador desta rota.
rotas.use('/matriculas', require('./rotas-matriculas')({ exigirLogin, exigirAdmin }));

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
