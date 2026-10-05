'use strict';

/**
 * app/src/rotas-totem.js — davileles/teamrausch
 *
 * O tablet fixo na entrada do estúdio, para confirmar a presença na aula de
 * hoje sem login.
 *
 * Cadastro não passa por aqui: o botão do tablet abre a própria tela de entrada
 * do app (`/?totem=1`), que já sabe pedir telefone, código, nome, aniversário e
 * os horários da semana. Duplicar esse fluxo daria duas versões para manter e
 * uma delas ficaria para trás.
 *
 * POR QUE SEM SENHA
 *   Quem está na frente do tablet já está dentro do estúdio. Pedir telefone,
 *   código no WhatsApp e digitação numa tela compartilhada, de pé, com fila
 *   atrás, é o tipo de atrito que faz todo mundo desistir e a recepção voltar a
 *   anotar em papel. A porta de entrada aqui é física.
 *
 *   Estas rotas são abertas de propósito: nenhum token de dispositivo, para o
 *   tablet ser só um atalho no navegador e não ter configuração para dar errado
 *   num domingo de manhã. O que sobra de proteção é o freio por IP mais abaixo
 *   e o fato de a busca devolver nome e nada mais.
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
const fs = require('fs');
const path = require('path');

const config = require('./config');
const agenda = require('./agenda');
const store = require('./agenda-store');
const gatilhos = require('./gatilhos-mensagens');
const matriculas = require('./matriculas-store');

const rotas = express.Router();
rotas.use(express.json());

/**
 * Janela em que a confirmação vale, em minutos ao redor do horário da aula.
 *
 * As pessoas chegam cedo, trocam de roupa e confirmam antes de entrar na sala;
 * quem confirma muito depois do início ou já treinou e voltou ao tablet, ou
 * está confirmando a aula errada. Os dois lados são editáveis em
 * Configurações → Frequência e cobrança.
 *
 * LIDO A CADA CHAMADA, NÃO NO BOOT
 *   Eram duas constantes de variável de ambiente. Como agora saem da tela,
 *   ler uma vez no carregamento do módulo faria a troca só valer no próximo
 *   deploy — o administrador salvaria e o tablet continuaria com o valor
 *   velho até alguém reiniciar o serviço.
 */
const PADRAO_ANTES = 20;
const PADRAO_DEPOIS = 20;

function janela() {
  let t = {};
  try {
    t = config.ler().totem || {};
  } catch (e) {
    t = {};   // config ilegível: o padrão evita recusar quem está na frente do tablet
  }
  const antes = Number(t.minutosAntes);
  const depois = Number(t.minutosDepois);
  return {
    antes: Number.isFinite(antes) && antes >= 0 ? antes : PADRAO_ANTES,
    depois: Number.isFinite(depois) && depois >= 0 ? depois : PADRAO_DEPOIS,
  };
}

/* ---------------------------- proteção ----------------------------------- */

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

/**
 * O horário de hoje que está acontecendo agora, dentro da janela.
 *
 * `atraso` (minutos) olha para trás no tempo: a presença guardada sem internet
 * é conferida contra o instante do toque, não contra a hora em que a fila do
 * tablet finalmente chegou aqui.
 */
function horarioDeAgora(meus, data, fuso, atraso = 0) {
  const { antes, depois } = janela();
  const dentro = meus
    .map((h) => ({ ...h, faltam: agenda.minutosAte(data, h.hora, fuso) + atraso }))
    .filter((h) => h.faltam <= antes && h.faltam >= -depois)
    // Duas aulas na janela ao mesmo tempo é raro; a mais próxima do agora ganha.
    .sort((a, b) => Math.abs(a.faltam) - Math.abs(b.faltam));
  return dentro[0] || null;
}

/**
 * O horário da grade em que a pessoa chegou — não o dela, o do estúdio.
 *
 * Quem chega 10h05 entrou na aula das 10h, mesmo que a matrícula dela seja das
 * 18h. É por isso que a busca é na grade do dia e não nos horários da pessoa:
 * a liberação existe justamente para quem apareceu num horário que não é o
 * seu, e creditar a presença no horário contratado deixaria a lista da aula
 * das 10h sem a pessoa que estava dentro dela.
 *
 * A aula que já começou ganha da que vai começar: às 10h05 o estúdio está com
 * a das 10h em andamento, e a das 11h ainda não é lugar nenhum. Sem nenhuma
 * aula no dia — feriado, domingo — sobra a hora cheia do relógio, que é o
 * melhor palpite possível e ainda deixa o registro conferível.
 */
function horaDaChegada(data, fuso, atraso = 0) {
  const slots = (agenda.listaDoDia(data).horarios || [])
    .map((h) => ({ hora: h.hora, faltam: agenda.minutosAte(data, h.hora, fuso) + atraso }));

  const comecadas = slots.filter((s) => s.faltam <= 0);
  if (comecadas.length) {
    return comecadas.sort((a, b) => b.faltam - a.faltam)[0].hora;   // a mais recente
  }
  const proximas = slots.filter((s) => s.faltam > 0);
  if (proximas.length) {
    return proximas.sort((a, b) => a.faltam - b.faltam)[0].hora;    // a que vem
  }

  const agoraHora = new Intl.DateTimeFormat('pt-BR', {
    timeZone: fuso, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(Date.now() - atraso * 60000));
  return `${agoraHora.slice(0, 2)}:00`;
}

/**
 * Administrador cujo telefone termina nestes quatro dígitos.
 *
 * A lista de administradores é a mesma da aba Configurações — quem já manda no
 * sistema é quem pode liberar uma entrada fora do horário. Não há senha aqui
 * de propósito: o professor está de pé ao lado do aluno, com fila atrás, e
 * qualquer coisa além de quatro toques faria a recepção voltar ao caderno.
 * O que segura a porta é o freio por tentativa mais o registro de quem liberou.
 */
function adminPorFinal(final) {
  const digitos = String(final || '').replace(/\D/g, '');
  if (digitos.length !== 4) return null;
  const lista = config.ler().administradores || [];
  return lista.find((t) => String(t || '').endsWith(digitos)) || null;
}

/** Nome do administrador, quando ele também tem cadastro de aluno. */
function nomeDoAdmin(telefone) {
  const direto = store.aluno(telefone);
  if (direto && direto.nome) return direto.nome;
  const achado = store.listarAlunos().find((a) => mesmoTelefone(a.telefone, telefone));
  return (achado && achado.nome) || null;
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
rotas.post('/buscar', comFreio(20), (req, res) => {
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
      // A chave vai junto para o tablet não perder a pessoa se a internet cair
      // entre a busca e a confirmação: ela é o que entra na fila offline.
      chave: chaveDe(a.telefone),
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
rotas.post('/confirmar', comFreio(30), (req, res) => {
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
    // Fora da janela deixou de ser fim de linha: o professor libera na hora,
    // pelos quatro dígitos dele. Vai um bilhete novo porque o da busca pode
    // estar quase vencendo, e o aluno ainda precisa chamar alguém — sem isto,
    // a liberação morreria de expiração no meio da caminhada até a sala.
    return res.json({
      ok: false, motivo, nome: aluno.nome || null,
      horariosDeHoje: meus.map((h) => h.hora),
      podeLiberar: true,
      bilhete: emitirBilhete(telefone),
      horaSugerida: horaDaChegada(data, fuso),
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
  if (!r.repetida) gatilhos.aulaNova('totem');

  res.json({
    ok: true,
    nome: aluno.nome || null,
    hora: agora.hora,
    repetida: r.repetida,
  });
});

/**
 * Presença liberada pelo professor, fora da janela do horário.
 *
 * O aluno chegou atrasado, veio num horário que não é o dele ou o cadastro não
 * tem aula hoje. Antes disto a tela só sabia mandar procurar o estúdio, e o
 * estúdio não tinha onde registrar — a pessoa treinava e o mês fechava
 * dizendo que ela não apareceu.
 *
 * A presença entra no horário da grade em que ela chegou, não no da matrícula:
 * quem entrou na aula das 10h aparece na aula das 10h.
 */
rotas.post('/liberar', comFreio(8), (req, res) => {
  const telefone = lerBilhete(req.body.bilhete);
  if (!telefone) {
    return res.status(400).json({ erro: 'A liberação expirou. Comece de novo.' });
  }

  const aluno = store.aluno(telefone);
  if (!aluno) return res.status(404).json({ erro: 'Cadastro não encontrado.' });
  if (aluno.bloqueado) {
    return res.json({ ok: false, motivo: 'Acesso suspenso. Fale com o estúdio.' });
  }

  const admin = adminPorFinal(req.body.final);
  if (!admin) {
    console.log(`[totem] liberação recusada — dígitos não são de administrador`
      + ` (aluno: ${aluno.nome || telefone})`);
    return res.json({ ok: false, motivo: 'Esses dígitos não são de um professor. Tente de novo.' });
  }

  // Liberar a si mesmo transformaria a autorização em formalidade: bastaria ser
  // administrador para nunca mais ter horário. Quem libera é sempre outra
  // pessoa, e é isso que faz o registro valer alguma coisa.
  if (mesmoTelefone(admin, telefone)) {
    return res.json({ ok: false, motivo: 'Peça a outro professor para liberar sua presença.' });
  }

  const c = config.ler();
  const fuso = c.estudio.fuso;
  const data = agenda.hoje(fuso);
  const hora = horaDaChegada(data, fuso);

  // Se por acaso ela tem agendamento neste mesmo horário, a presença fica
  // amarrada a ele — assim a aula não conta a mesma pessoa duas vezes, uma
  // como reserva e outra como liberação solta.
  const meu = horariosDeHoje(telefone, data).find((h) => h.hora === hora);

  const r = store.registrarPresenca({
    telefone,
    nome: aluno.nome,
    data,
    hora,
    agendamentoId: meu ? meu.agendamentoId : null,
    origem: 'totem-liberado',
    liberadoPor: admin,
  });

  const professor = nomeDoAdmin(admin);
  console.log(`[totem] presença LIBERADA ${data} ${hora} — ${aluno.nome || telefone}`
    + ` por ${professor || admin}${r.repetida ? ' (repetida)' : ''}`);
  if (!r.repetida) gatilhos.aulaNova('totem-liberado');

  res.json({
    ok: true,
    nome: aluno.nome || null,
    hora,
    professor: professor ? professor.split(' ')[0] : null,
    repetida: r.repetida,
  });
});

/* ------------------------------ modo offline ----------------------------- */
/*
 * QUANDO A INTERNET DO ESTÚDIO CAI
 *   O tablet continua confirmando presença: guarda a página (service worker
 *   `sw-totem.js`), baixa de tempos em tempos um pacote com quem pode passar
 *   por ele e a agenda dos próximos dias, e enfileira cada toque no próprio
 *   aparelho. Quando a conexão volta, a fila chega aqui e cada item é conferido
 *   com as MESMAS regras das rotas acima, no instante do toque.
 *
 * CHAVE NO LUGAR DO TELEFONE
 *   O pacote não leva telefone. Leva os 4 últimos dígitos (que já são a busca
 *   do tablet), o primeiro nome com a inicial do sobrenome e uma chave opaca —
 *   HMAC do telefone com um segredo que só este servidor tem. A fila devolve a
 *   chave e só aqui ela vira telefone de novo.
 *
 * O QUE O TABLET NÃO SABE OFFLINE
 *   Os dígitos do professor. A liberação fora do horário é guardada como
 *   pedido e conferida aqui na sincronização; dígito que não é de professor
 *   não vira presença (fica no log). Publicar a lista de finais dos
 *   administradores para o tablet conferir sozinho seria entregar a senha da
 *   liberação a quem abrir o pacote.
 *
 * NADA DISTO TOCA O WELLHUB
 *   Como as rotas de cima, isto só grava presença do totem. Check-in e
 *   cobrança do Wellhub seguem pelo portal, separados.
 */

const DIR_DADOS = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ARQ_SEGREDO = path.join(DIR_DADOS, 'totem-segredo.txt');
const DIAS_NO_PACOTE = 7;
const MAX_ITENS_FILA = 300;
const IDADE_MAXIMA_ITEM_DIAS = 10;

let segredoMemoria = null;

/**
 * Segredo das chaves. Fica no volume: trocar a cada deploy invalidaria as
 * chaves que estão na fila de um tablet que ficou o dia todo sem internet.
 */
function segredo() {
  if (segredoMemoria) return segredoMemoria;
  if (process.env.TOTEM_SEGREDO) {
    segredoMemoria = process.env.TOTEM_SEGREDO;
    return segredoMemoria;
  }
  try {
    const lido = fs.readFileSync(ARQ_SEGREDO, 'utf8').trim();
    if (lido.length >= 32) { segredoMemoria = lido; return segredoMemoria; }
  } catch (e) { /* ainda não existe */ }
  segredoMemoria = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(DIR_DADOS, { recursive: true });
    fs.writeFileSync(ARQ_SEGREDO, segredoMemoria, { mode: 0o600 });
  } catch (e) {
    console.log('[totem] não consegui gravar o segredo do modo offline:', e.message);
  }
  return segredoMemoria;
}

function chaveDe(telefone) {
  return crypto.createHmac('sha256', segredo())
    .update(String(telefone || '').replace(/\D/g, ''))
    .digest('hex').slice(0, 24);
}

/** "Maria Souza Lima" → "Maria L." — o bastante para escolher entre homônimos. */
function nomeCurto(nome) {
  const partes = String(nome || '').trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return 'Sem nome';
  if (partes.length === 1) return partes[0];
  return `${partes[0]} ${partes[partes.length - 1].charAt(0).toUpperCase()}.`;
}

function somarDias(data, n) {
  const d = new Date(`${data}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Data local do estúdio em que um instante caiu. */
function dataLocal(ms, fuso) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

/** Para o tablet saber, sem esperar timeout de busca, se há caminho até aqui. */
rotas.get('/ping', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, agora: new Date().toISOString() });
});

/**
 * O que o tablet precisa para atender sem internet: alunos (final, nome curto,
 * chave), a janela de confirmação e, para cada um dos próximos dias, os
 * horários da grade e as chaves esperadas em cada um.
 */
rotas.get('/pacote', comFreio(6), (req, res) => {
  const c = config.ler();
  const fuso = c.estudio.fuso;
  const inicio = agenda.hoje(fuso);

  const chaves = new Map();
  const alunos = [];
  for (const a of store.listarAlunos()) {
    if (a.bloqueado) continue;
    const digitos = String(a.telefone || '').replace(/\D/g, '');
    if (digitos.length < 8) continue;
    const chave = chaveDe(a.telefone);
    chaves.set(digitos.slice(-8), chave);
    alunos.push({ c: chave, f: digitos.slice(-4), n: nomeCurto(a.nome) });
  }

  const dias = {};
  for (let i = 0; i < DIAS_NO_PACOTE; i++) {
    const data = somarDias(inicio, i);
    try {
      const lista = agenda.listaDoDia(data);
      const horas = [];
      const por = {};
      for (const h of lista.horarios || []) {
        horas.push(h.hora);
        for (const al of h.alunos || []) {
          const d = String(al.telefone || '').replace(/\D/g, '');
          const chave = d.length >= 8 ? chaves.get(d.slice(-8)) : null;
          if (!chave) continue;
          (por[chave] = por[chave] || []).push(h.hora);
        }
      }
      dias[data] = { horas, por };
    } catch (e) {
      // Um dia que não monta não derruba o pacote: o tablet manda a presença
      // sem conferir a janela e a sincronização decide.
    }
  }

  res.set('Cache-Control', 'no-store');
  res.json({
    geradoEm: new Date().toISOString(),
    fuso,
    janela: janela(),
    alunos,
    dias,
  });
});

/**
 * Freio próprio para dígito de professor vindo da fila: sem ele, a fila seria
 * um jeito de testar os dez mil finais em lote, fora do freio de /liberar.
 */
const falhasLiberacao = new Map();
function liberacaoTravada(ip) {
  const agora = Date.now();
  const recentes = (falhasLiberacao.get(ip) || []).filter((t) => t > agora - 10 * 60000);
  falhasLiberacao.set(ip, recentes);
  return recentes.length >= 8;
}
function anotarFalhaLiberacao(ip) {
  const lista = falhasLiberacao.get(ip) || [];
  lista.push(Date.now());
  falhasLiberacao.set(ip, lista);
}

/**
 * A fila do tablet chegando. Cada item volta com um destino:
 *   ok / repetida — gravado (ou já estava); o tablet apaga.
 *   recusado      — não vira presença; o tablet apaga e o motivo fica no log.
 *   depois        — não deu para decidir agora; o tablet tenta de novo.
 */
rotas.post('/sincronizar', comFreio(20), (req, res) => {
  const itens = Array.isArray(req.body.itens) ? req.body.itens.slice(0, MAX_ITENS_FILA) : [];
  const c = config.ler();
  const fuso = c.estudio.fuso;
  const ip = req.ip || 'desconhecido';

  const porChave = new Map();
  for (const a of store.listarAlunos()) porChave.set(chaveDe(a.telefone), a.telefone);

  const resultados = [];
  let novas = 0;
  const recusa = (item, motivo, extra = {}) => {
    console.log(`[totem] fila offline: item ${item.id || '?'} recusado — ${motivo}`
      + (extra.nome ? ` (${extra.nome})` : ''));
    return { id: item.id, status: 'recusado', motivo, ...extra };
  };

  for (const item of itens) {
    try {
      if (!item || typeof item !== 'object' || !item.id) continue;
      const tipo = item.tipo === 'liberar' ? 'liberar' : 'confirmar';

      const em = Date.parse(item.em);
      if (!Number.isFinite(em)) { resultados.push(recusa(item, 'Horário do toque ilegível.')); continue; }
      if (em > Date.now() + 10 * 60000) { resultados.push(recusa(item, 'Horário do toque no futuro (relógio do tablet errado).')); continue; }
      if (em < Date.now() - IDADE_MAXIMA_ITEM_DIAS * 86400000) {
        resultados.push(recusa(item, `Toque com mais de ${IDADE_MAXIMA_ITEM_DIAS} dias.`)); continue;
      }

      const telefone = porChave.get(String(item.chave || ''));
      if (!telefone) { resultados.push(recusa(item, 'Cadastro não encontrado.')); continue; }
      const aluno = store.aluno(telefone);
      if (!aluno) { resultados.push(recusa(item, 'Cadastro não encontrado.')); continue; }
      if (aluno.bloqueado) { resultados.push(recusa(item, 'Acesso suspenso.', { nome: aluno.nome })); continue; }

      const atraso = (Date.now() - em) / 60000;
      const data = dataLocal(em, fuso);
      const meus = horariosDeHoje(telefone, data);
      const horaInformada = /^\d{2}:\d{2}$/.test(String(item.hora || '')) ? String(item.hora) : null;

      let registro;
      if (tipo === 'confirmar') {
        let alvo = horarioDeAgora(meus, data, fuso, atraso);
        if (!alvo && horaInformada) {
          // O tablet conferiu com a agenda que tinha guardada. Se a grade mudou
          // desde então, vale a hora que ele mostrou para a pessoa — desde que
          // ela ainda caia na janela do instante do toque.
          const { antes, depois } = janela();
          const faltam = agenda.minutosAte(data, horaInformada, fuso) + atraso;
          if (faltam <= antes && faltam >= -depois) alvo = { hora: horaInformada, agendamentoId: null };
        }
        if (!alvo) { resultados.push(recusa(item, 'Fora do horário agendado.', { nome: aluno.nome })); continue; }
        registro = store.registrarPresenca({
          telefone, nome: aluno.nome, data, hora: alvo.hora,
          agendamentoId: alvo.agendamentoId || null,
          origem: 'totem', criadoEm: new Date(em).toISOString(), offline: true,
        });
      } else {
        if (liberacaoTravada(ip)) {
          resultados.push({ id: item.id, status: 'depois', motivo: 'Muitas liberações recusadas; tento mais tarde.' });
          continue;
        }
        const admin = adminPorFinal(item.final);
        if (!admin) {
          anotarFalhaLiberacao(ip);
          resultados.push(recusa(item, 'Dígitos do professor não conferem.', { nome: aluno.nome }));
          continue;
        }
        if (mesmoTelefone(admin, telefone)) {
          resultados.push(recusa(item, 'Professor liberando a própria presença.', { nome: aluno.nome }));
          continue;
        }
        const hora = horaInformada || horaDaChegada(data, fuso, atraso);
        const meu = meus.find((h) => h.hora === hora);
        registro = store.registrarPresenca({
          telefone, nome: aluno.nome, data, hora,
          agendamentoId: meu ? meu.agendamentoId : null,
          origem: 'totem-liberado', liberadoPor: admin,
          criadoEm: new Date(em).toISOString(), offline: true,
        });
      }

      if (!registro.repetida) novas++;
      console.log(`[totem] fila offline: presença ${tipo === 'liberar' ? 'LIBERADA ' : ''}`
        + `${registro.presenca.data} ${registro.presenca.hora} — ${aluno.nome || telefone}`
        + `${registro.repetida ? ' (repetida)' : ''}`);
      resultados.push({
        id: item.id,
        status: registro.repetida ? 'repetida' : 'ok',
        nome: aluno.nome || null,
        hora: registro.presenca.hora,
      });
    } catch (e) {
      console.log('[totem] fila offline: erro ao processar item', item && item.id, '—', e.message);
      resultados.push({ id: item && item.id, status: 'depois', motivo: 'Erro no servidor.' });
    }
  }

  if (novas) gatilhos.aulaNova('totem');
  res.json({ resultados, novas });
});

module.exports = { rotas };
