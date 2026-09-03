'use strict';

const express = require('express');
const crypto = require('crypto');
const config = require('./config');
const store = require('./agenda-store');
const agenda = require('./agenda');
const matriculas = require('./matriculas-store');
const grade = require('./grade');
const { enviarCodigo } = require('./mensageiro');
// Só pelos destinatários e pelo canal de e-mail: o aviso de primeiro acesso
// reaproveita a mesma lista dos avisos do Wellhub em vez de abrir uma segunda.
const poller = require('./poller-portal');

const rotas = express.Router();

/* --------------------------- telefone ------------------------------------ */

/** Aceita (31) 98888-7777, 31988887777, +55 31 98888-7777 → 5531988887777 */
// Formato do telefone e lista de administradores vêm de módulos compartilhados:
// a tela de matrículas faz a mesma checagem desde que absorveu a aba Alunos.
const telefoneUtil = require('./telefone');
const normalizarTelefone = telefoneUtil.normalizar;
const mostrarTelefone = telefoneUtil.mostrar;
const ehAdmin = config.ehAdmin;

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
// A validação mora em `aniversario.js`: a matrícula guarda o mesmo campo e as
// duas telas precisam concordar sobre o que é uma data válida.

const aniversario = require('./aniversario');
const normalizarAniversario = aniversario.normalizar;
const mostrarAniversario = aniversario.mostrar;

/* --------------------- primeiro acesso do telefone ------------------------ */

/**
 * Primeiro acesso = este telefone nunca entrou no app, mesmo que a ficha já
 * exista aqui.
 *
 * `ultimoAcesso` só é escrito no login, então a ausência dele é a marca segura
 * de quem veio da importação e nunca abriu o app. Essa gente costuma ter nome
 * pela metade ("Ana", "Ana P.") e nenhum aniversário; pedir os dois campos na
 * primeira entrada é o que fecha esses buracos sozinho, sem alguém ter que
 * caçar aluno por aluno na planilha.
 */
function primeiroAcesso(cadastrado) {
  return !cadastrado || !cadastrado.ultimoAcesso;
}

/** Nome completo = pelo menos duas palavras de duas letras ou mais. */
function nomeCompleto(texto) {
  return String(texto || '').trim().split(/\s+/).filter((p) => p.length >= 2).length >= 2;
}

/**
 * Nome que o Wellhub já conhece para este telefone, para a tela de entrada
 * abrir preenchida em vez de em branco.
 *
 * Só vale quando o portal realmente identificou a ficha — `gympassId` gravado
 * ou algum nome que veio de um check-in (`nomeWellhub`). Nesses casos o nome
 * saiu do cadastro que a pessoa mesma fez no Wellhub, com nome e sobrenome
 * escritos direito; é melhor palpite do que a digitação apressada de quem está
 * entrando pela primeira vez, e a pessoa só precisa conferir.
 *
 * Ficha que existe só porque veio da planilha não entra: ali o nome pode ser
 * apelido ou abreviação, e sugerir isso seria empurrar o erro para dentro do
 * cadastro definitivo.
 *
 * Continua sendo sugestão — o campo permanece editável e o servidor exige nome
 * completo do mesmo jeito em `/auth/entrar`.
 */
function nomeDoWellhub(telefone) {
  const m = matriculas.porTelefone(telefone);
  if (!m) return null;
  if (!m.gympassId && !m.nomeWellhub) return null;
  const nome = String(m.nome || '').trim();
  return nomeCompleto(nome) ? nome : null;
}

/* --------------------- grade semanal do primeiro acesso ------------------- */

/**
 * Horários abertos em cada dia da semana, no formato que a tela de entrada
 * consome. Sai da configuração do estúdio (Configurações → Horários da
 * semana), então abrir ou fechar um horário lá muda o que o aluno pode
 * escolher aqui, sem passar por código.
 */
function horariosDaSemana() {
  const c = config.ler();
  return config.DIAS.map((chave, dia) => ({
    dia,
    nome: grade.NOME_DIA[dia],
    horas: [...new Set((c.agenda.horarios[chave] || []).map((h) => String(h.hora)))]
      .sort((a, b) => a.localeCompare(b)),
  })).filter((d) => d.horas.length);
}

/**
 * A grade semanal precisa passar pelas mãos deste telefone.
 *
 * Dois casos, e o segundo é o que justifica a tela existir mesmo para quem já
 * tem horário montado:
 *
 *   1. Não há grade nenhuma — nem ficha, ou ficha que veio da importação sem
 *      horário. Ninguém sabe em que turma a pessoa treina.
 *   2. Há grade, mas este telefone nunca abriu o app. O horário foi digitado
 *      por outra pessoa, a partir de uma planilha que envelheceu. Mostrar o que
 *      está gravado e pedir confirmação é a única hora em que o dono do número
 *      olha para aquilo — depois disso ninguém mais confere.
 *
 * Duas exceções: administrador, que entra para gerir e não para treinar, e
 * estúdio sem nenhum horário cadastrado — aí não há o que escolher, e travar a
 * entrada de todo mundo seria pior do que deixar a grade para depois.
 */
function precisaDeGrade(cadastrado, telefone) {
  if (ehAdmin(telefone)) return false;
  if (!horariosDaSemana().length) return false;
  if (primeiroAcesso(cadastrado)) return true;
  const m = matriculas.porTelefone(telefone);
  return !(m && (m.grade || []).length);
}

/**
 * A grade que já está gravada, para a tela abrir marcada em vez de em branco.
 *
 * Horário que saiu da configuração desde que a ficha foi montada não pode ser
 * pré-selecionado — a lista de opções não o tem mais. O dia continua marcado
 * e cai no primeiro horário aberto, que é justamente o caso em que a
 * confirmação do aluno vale mais.
 */
function gradeGravada(telefone) {
  const m = matriculas.porTelefone(telefone);
  if (!m) return [];
  const abertos = new Map(horariosDaSemana().map((d) => [d.dia, d.horas]));
  return (m.grade || [])
    .filter((s) => abertos.has(s.dia))
    .map((s) => ({
      dia: s.dia,
      hora: abertos.get(s.dia).includes(s.hora) ? s.hora : abertos.get(s.dia)[0],
    }));
}

/**
 * Confere a grade escolhida contra os horários que o estúdio abriu.
 *
 * Um horário por dia, como no resto do sistema (ver `grade.conflitosDeGrade`):
 * a grade é o compromisso de rotina, e dois horários no mesmo dia sempre
 * significaram "ou um, ou outro", nunca duas aulas.
 */
function validarGrade(bruta) {
  if (!Array.isArray(bruta) || !bruta.length) {
    return { ok: false, motivo: 'Escolha pelo menos um dia e horário da sua semana.' };
  }
  const abertos = new Map(horariosDaSemana().map((d) => [d.dia, d.horas]));
  const porDia = new Map();

  for (const s of bruta) {
    const dia = Number(s && s.dia);
    const hora = String((s && s.hora) || '').trim();
    if (!abertos.has(dia)) {
      return { ok: false, motivo: 'Dia da semana sem horário aberto no estúdio.' };
    }
    if (!abertos.get(dia).includes(hora)) {
      return {
        ok: false,
        motivo: `${grade.NOME_DIA[dia]}: escolha um dos horários abertos.`,
      };
    }
    if (porDia.has(dia) && porDia.get(dia) !== hora) {
      return {
        ok: false,
        motivo: `${grade.NOME_DIA[dia]}: um horário só por dia da semana.`,
      };
    }
    porDia.set(dia, hora);
  }

  const limpa = [...porDia.entries()]
    .map(([dia, hora]) => ({ dia, hora }))
    .sort((a, b) => a.dia - b.dia);
  return { ok: true, grade: limpa };
}

/**
 * Leva a grade escolhida para a matrícula, que é a base que o estúdio lê.
 *
 * Quem já tem ficha recebe a grade nela; quem chegou sem ficha ganha uma,
 * marcada para conferência — vínculo e cobrança só o estúdio sabe, e inventar
 * isso seria pior do que deixar o campo pedindo revisão.
 *
 * Falha aqui não derruba o login: o código já foi conferido e a pessoa já é
 * dona do número. Vira aviso no log, e a grade volta a ser pedida na entrada
 * seguinte — melhor do que trancar o acesso por um homônimo na base.
 */
function aplicarGradeNaMatricula(telefone, nome, aniversario, gradeEscolhida) {
  const mesmoNome = (a, b) =>
    String(a || '').trim().toLocaleLowerCase('pt-BR')
    === String(b || '').trim().toLocaleLowerCase('pt-BR');

  const m = matriculas.porTelefone(telefone)
    || matriculas.listar().find((x) => !x.telefone && mesmoNome(x.nome, nome));

  if (m) {
    const campos = { grade: gradeEscolhida };
    if (!m.telefone) campos.telefone = telefone;
    // Ficha de aula experimental existe justamente por não ter horário fixo
    // combinado. Combinado agora, a marca não descreve mais a situação.
    if (m.experimental) campos.experimental = false;
    return matriculas.atualizar(m.id, campos);
  }

  // O nome digitado aqui é o que a pessoa usa no dia a dia; a base pode ter o
  // completo, vindo da planilha ou do Wellhub. Nesse caso a ficha nasce assim
  // mesmo — adivinhar juntaria dois homônimos — mas já marcada para revisão,
  // com o nome da provável gêmea, para ser mesclada na tela em vez de virar
  // dois resultados na busca.
  const parecidas = matriculas.possiveisDuplicadas(nome);
  return matriculas.criar({
    nome,
    telefone,
    aniversario,
    vinculo: 'mensalista',
    grade: gradeEscolhida,
    observacao: 'Ficha aberta pelo próprio aluno no primeiro acesso — conferir vínculo e cobrança.',
    revisar: parecidas.length
      ? [`Pode ser a mesma pessoa de ${parecidas.map((x) => x.nome).join(', ')}`
        + ' — confira e mescle as fichas se for.']
      : [],
  });
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
      precisaDeNome: primeiroAcesso(cadastrado) || !cadastrado.nome,
      precisaDeAniversario: primeiroAcesso(cadastrado) || !cadastrado.aniversario,
      precisaDeGrade: precisaDeGrade(cadastrado, telefone),
      gradeAtual: gradeGravada(telefone),
      nomeSugerido: nomeDoWellhub(telefone),
      horarios: horariosDaSemana(),
    });
  }

  // Canal aberto: não gera nem envia código. A tela pula direto para o cadastro.
  if (entraSemCodigo(telefone)) {
    return res.json({
      enviado: true,
      canal: 'aberto',
      semCodigo: true,
      telefone: mostrarTelefone(telefone),
      precisaDeNome: primeiroAcesso(cadastrado) || !cadastrado.nome,
      precisaDeAniversario: primeiroAcesso(cadastrado) || !cadastrado.aniversario,
      precisaDeGrade: precisaDeGrade(cadastrado, telefone),
      gradeAtual: gradeGravada(telefone),
      nomeSugerido: nomeDoWellhub(telefone),
      horarios: horariosDaSemana(),
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
    precisaDeNome: primeiroAcesso(cadastrado) || !cadastrado.nome,
    precisaDeAniversario: primeiroAcesso(cadastrado) || !cadastrado.aniversario,
    precisaDeGrade: precisaDeGrade(cadastrado, telefone),
    gradeAtual: gradeGravada(telefone),
    nomeSugerido: nomeDoWellhub(telefone),
    horarios: horariosDaSemana(),
  });
});

/**
 * Avisa o estúdio, por e-mail, quando alguém entra no app pela primeira vez.
 *
 * O cadastro aqui é auto-serviço: nome, aniversário e grade da semana chegam
 * pela mão do próprio aluno, sem ninguém do estúdio na frente. Sem aviso, a
 * única forma de descobrir que apareceu gente nova — ou que uma ficha da
 * planilha acabou de virar matrícula de verdade — era abrir a lista e comparar
 * com a memória.
 *
 * Vai para os mesmos destinatários dos avisos do Wellhub (aba Configurações,
 * bloco `avisos`). É a mesma gente que opera o estúdio, e uma segunda lista só
 * criaria mais um lugar para esquecer de atualizar.
 *
 * Fica fora do caminho da resposta de propósito: o login não espera a Resend, e
 * e-mail que não sai nunca é motivo para barrar a entrada de quem já provou ser
 * dono do número.
 */
function avisarPrimeiroAcesso(telefone, aluno, aniversarioGravado, horariosEscolhidos) {
  const fuso = process.env.TZ_ESTUDIO || 'America/Sao_Paulo';
  const quem = aluno.nome || mostrarTelefone(telefone);

  const linhas = [
    `Nome: ${aluno.nome || '—'}`,
    `Telefone: ${mostrarTelefone(telefone)}`,
    `Aniversário: ${mostrarAniversario(aniversarioGravado) || '—'}`,
    '',
    'Grade da semana:',
  ];

  // A grade escolhida agora manda; quem já entrou com uma gravada não escolhe
  // de novo, e nesse caso o aviso mostra a que está valendo.
  const semana = (horariosEscolhidos && horariosEscolhidos.length)
    ? horariosEscolhidos
    : gradeGravada(telefone);
  if (semana.length) {
    for (const s of semana) linhas.push(`  • ${grade.NOME_DIA[s.dia]} às ${s.hora}`);
  } else {
    linhas.push('  (nenhum horário fixo)');
  }

  // Lido depois de a grade ter sido aplicada: é aqui que se vê se a pessoa caiu
  // numa ficha que já existia ou se abriu uma do zero, que é o caso que pede
  // conferência de vínculo e cobrança.
  const m = matriculas.porTelefone(telefone);
  linhas.push('');
  if (m) {
    linhas.push(`Matrícula: ${m.nome} (#${m.id})`);
    if (m.vinculo) linhas.push(`Vínculo: ${m.vinculo}`);
    if (m.observacao) linhas.push(`Observação: ${m.observacao}`);
  } else {
    linhas.push('Matrícula: nenhuma ficha vinculada a este telefone.');
  }
  linhas.push(`Quando: ${new Date().toLocaleString('pt-BR', { timeZone: fuso })}`);

  Promise.resolve()
    .then(() => poller.enviarEmail(`🆕 Primeiro acesso no app: ${quem}`, linhas.join('\n')))
    .catch((e) => console.warn(`[acesso] aviso de primeiro acesso não saiu: ${e.message}`));
}

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
  const primeiraVez = primeiroAcesso(existente);

  // Quem tem Wellhub tem o nome do próprio cadastro lá, completo e escrito
  // direito. Ele manda: o que a pessoa digitou aqui pode ser apelido, primeiro
  // nome só ou pressa, e deixar isso entrar faria a base divergir da fila do
  // portal já na primeira gravação.
  const doWellhub = nomeDoWellhub(telefone);

  // Primeiro acesso deste telefone: nome completo e aniversário são obrigatórios,
  // mesmo quando a ficha já existe. O que veio da importação entra como rascunho
  // — quem confirma é o dono do número, na primeira vez que entra.
  if (primeiraVez || !existente.nome) {
    if (!nome) return res.status(400).json({ erro: 'Informe seu nome completo.' });
    if (!nomeCompleto(nome)) {
      return res.status(400).json({ erro: 'Informe o nome completo: nome e sobrenome.' });
    }
  }

  let aniversario = (existente && existente.aniversario) || null;
  if (req.body.aniversario !== undefined && String(req.body.aniversario).trim()) {
    aniversario = normalizarAniversario(req.body.aniversario);
    if (!aniversario) {
      return res.status(400).json({ erro: 'Aniversário inválido. Use dia e mês, como 07/03.' });
    }
  } else if (primeiraVez) {
    // Data importada não confirmada não conta: cai no erro abaixo e a tela pede.
    aniversario = null;
  }
  if (!aniversario) {
    return res.status(400).json({ erro: 'Informe seu aniversário (dia e mês).' });
  }

  // Grade semanal padrão: os dias e horários em que a pessoa treina de rotina.
  // Sem isso ela entra no app e não existe em nenhuma lista de presença — o
  // estúdio teria de descobrir o horário dela por WhatsApp, um a um. Quem já
  // tem grade também passa por aqui na primeira entrada: a tela vem marcada e
  // o que volta é a confirmação do dono do número, não um palpite da planilha.
  let gradeEscolhida = null;
  if (precisaDeGrade(existente, telefone)) {
    const conferida = validarGrade(req.body.grade);
    if (!conferida.ok) return res.status(400).json({ erro: conferida.motivo });
    gradeEscolhida = conferida.grade;
  }

  const aluno = store.salvarAluno(telefone, {
    nome: doWellhub || nome || (existente && existente.nome) || null,
    aniversario,
    ultimoAcesso: new Date().toISOString(),
  });

  // O que o aluno acabou de confirmar volta para a matrícula, que é a base que
  // veio incompleta da planilha. Só preenche buraco: nome de uma palavra só e
  // aniversário vazio. Nome já completo na matrícula fica como está — lá o
  // estúdio pode ter ajustado a grafia de propósito.
  if (primeiraVez) {
    const m = matriculas.porTelefone(telefone);
    if (m) {
      const campos = {};
      // Ficha com Wellhub não recebe o nome digitado: lá o nome já veio do
      // portal e é ele que vale.
      if (!doWellhub && nome && !nomeCompleto(m.nome)) campos.nome = nome;
      if (!m.aniversario) campos.aniversario = aniversario;
      if (Object.keys(campos).length) {
        const r = matriculas.atualizar(m.id, campos);
        if (!r.ok) console.warn(`[acesso] não deu para completar a matrícula ${m.id}: ${r.motivo}`);
      }
    }
  }

  if (gradeEscolhida) {
    const r = aplicarGradeNaMatricula(telefone, aluno.nome, aniversario, gradeEscolhida);
    if (!r.ok) console.warn(`[acesso] grade de ${telefone} não foi gravada: ${r.motivo}`);
  }

  // Depois da grade: assim o aviso já sai com a matrícula no estado final.
  if (primeiraVez) avisarPrimeiroAcesso(telefone, aluno, aniversario, gradeEscolhida);

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
      nomeDoWellhub: Boolean(nomeDoWellhub(req.aluno.telefone)),
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
    // A tela usa isto para travar o campo de nome: com Wellhub, quem nomeia é
    // o portal, e um campo editável que não guarda seria só frustração.
    nomeDoWellhub: Boolean(nomeDoWellhub(req.aluno.telefone)),
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
  // Nome de quem tem Wellhub não se edita aqui: o portal reescreveria no
  // check-in seguinte, e a pessoa acharia que o sistema perdeu o que ela
  // salvou. Melhor não aceitar do que aceitar e desfazer sozinho.
  const doWellhub = nomeDoWellhub(req.aluno.telefone);

  if (req.body.nome !== undefined && !doWellhub) {
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

  if (doWellhub && doWellhub !== req.aluno.nome) campos.nome = doWellhub;

  const aluno = store.salvarAluno(req.aluno.telefone, campos);
  res.json({
    nome: aluno.nome,
    telefone: mostrarTelefone(aluno.telefone),
    aniversario: mostrarAniversario(aluno.aniversario),
    nomeDoWellhub: Boolean(doWellhub),
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

/**
 * Grupos de que o número do estúdio participa, para escolher o grupo dos
 * avisos sem ter de descobrir o JID na mão.
 *
 * O serviço de WhatsApp vive na rede interna do Railway e não abre no
 * navegador; esta rota é a única porta para a lista. Reaproveita o endereço e
 * o token de Configurações → Técnica: trocando `/enviar` por `/grupos` não há
 * um segundo lugar para configurar.
 */
rotas.get('/admin/whatsapp/grupos', exigirLogin, exigirAdmin, async (_req, res) => {
  const c = config.ler();
  const base = (c.envio && c.envio.url) || process.env.WHATSAPP_URL || '';
  if (!base) return res.status(400).json({ erro: 'Endereço do serviço de WhatsApp não configurado.' });

  let alvo;
  try {
    const u = new URL(base);
    u.pathname = '/grupos';
    u.search = '';
    alvo = u.toString();
  } catch (e) {
    return res.status(400).json({ erro: 'Endereço do serviço de WhatsApp inválido.' });
  }

  const token = (c.envio && c.envio.token) || process.env.WHATSAPP_TOKEN || '';
  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(), 10000);
  try {
    const r = await fetch(alvo, {
      headers: token
        ? { authorization: /^Bearer /i.test(token) ? token : `Bearer ${token}` }
        : {},
      signal: controle.signal,
    });
    const texto = await r.text().catch(() => '');
    if (!r.ok) {
      return res.status(502).json({ erro: `O serviço de WhatsApp respondeu ${r.status}: ${texto.slice(0, 200)}` });
    }
    let dados = {};
    try { dados = JSON.parse(texto); } catch (e) { dados = {}; }
    res.json({ grupos: Array.isArray(dados.grupos) ? dados.grupos : [] });
  } catch (e) {
    res.status(502).json({ erro: `Não consegui falar com o serviço de WhatsApp: ${e.message}` });
  } finally {
    clearTimeout(timer);
  }
});

/**
 * QR de pareamento do número do estúdio, para a aba Configurações → Técnica.
 *
 * Mesma ponte da rota de grupos: o serviço de WhatsApp vive na rede interna do
 * Railway e o `/qr` de lá exige token em cabeçalho, que o navegador não manda.
 * Aqui a sessão de administrador já foi conferida, então o painel só desenha o
 * que voltar. O QR expira em segundos — a tela repete a chamada sozinha.
 */
rotas.get('/admin/whatsapp/qr', exigirLogin, exigirAdmin, async (_req, res) => {
  const c = config.ler();
  const base = (c.envio && c.envio.url) || process.env.WHATSAPP_URL || '';
  if (!base) return res.status(400).json({ erro: 'Endereço do serviço de WhatsApp não configurado.' });

  let alvo;
  try {
    const u = new URL(base);
    u.pathname = '/qr.json';
    u.search = '';
    alvo = u.toString();
  } catch (e) {
    return res.status(400).json({ erro: 'Endereço do serviço de WhatsApp inválido.' });
  }

  const token = (c.envio && c.envio.token) || process.env.WHATSAPP_TOKEN || '';
  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(), 10000);
  try {
    const r = await fetch(alvo, {
      headers: token
        ? { authorization: /^Bearer /i.test(token) ? token : `Bearer ${token}` }
        : {},
      signal: controle.signal,
    });
    const texto = await r.text().catch(() => '');
    if (r.status === 404) {
      return res.status(502).json({
        erro: 'O serviço de WhatsApp ainda não tem /qr.json. Aguarde o deploy terminar e tente de novo.',
      });
    }
    if (!r.ok) {
      return res.status(502).json({ erro: `O serviço de WhatsApp respondeu ${r.status}: ${texto.slice(0, 200)}` });
    }
    let dados = {};
    try { dados = JSON.parse(texto); } catch (e) { dados = {}; }
    res.json({
      situacao: dados.situacao || 'desconhecida',
      numero: dados.numero || null,
      temQr: Boolean(dados.temQr),
      imagem: dados.imagem || null,
    });
  } catch (e) {
    res.status(502).json({ erro: `Não consegui falar com o serviço de WhatsApp: ${e.message}` });
  } finally {
    clearTimeout(timer);
  }
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

    // Grupos do WhatsApp (o "grupo do operador"). Guardamos o JID inteiro:
    // é o que o serviço de WhatsApp usa como endereço.
    if (a.grupos !== undefined) {
      if (!Array.isArray(a.grupos)) {
        return res.status(400).json({ erro: 'Lista de grupos inválida.' });
      }
      const limpos = [];
      for (const bruto of a.grupos) {
        const jid = String(bruto || '').trim();
        if (!jid) continue;
        if (!/^\d{5,}@g\.us$/.test(jid)) {
          return res.status(400).json({ erro: `Grupo inválido: ${jid}. Use o ID terminado em @g.us.` });
        }
        limpos.push(jid);
      }
      a.grupos = [...new Set(limpos)];
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

/* A gestão do cadastro de login — nome, telefone, suspensão e remoção — mudou
   para a ficha da matrícula, em `rotas-matriculas.js`. A aba Alunos deixou de
   existir e as rotas /admin/alunos foram embora junto: mantê-las de pé sem tela
   seria código sem dono, e a mesma edição em dois caminhos diferentes é como se
   perde a sincronia entre a matrícula e a ficha de acesso. */

rotas.get('/admin/backup', exigirLogin, exigirAdmin, (_req, res) => {
  res.json(store.backup.situacao());
});

/* --------------------- cadastro interno e grade fixa ---------------------- */
// Base própria, com chave por id em vez de telefone: veio da planilha do
// estúdio e a maioria dos alunos ainda não tem número cadastrado. Montada aqui
// para reaproveitar a sessão e a checagem de administrador desta rota.
rotas.use('/matriculas', require('./rotas-matriculas')({ exigirLogin, exigirAdmin }));

/* ---------------------------- mensagens --------------------------------- */
// Modelos, disparo para o aluno e histórico do que já saiu. Montado aqui pelo
// mesmo motivo das matrículas: a sessão e a checagem de administrador já
// existem nesta rota.
rotas.use('/mensagens', require('./rotas-mensagens')({ exigirLogin, exigirAdmin }));

module.exports = {
  rotas, normalizarTelefone, mostrarTelefone, ehAdmin,
  normalizarAniversario, mostrarAniversario,
};
