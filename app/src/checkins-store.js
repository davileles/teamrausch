'use strict';

/**
 * app/src/checkins-store.js — davileles/teamrausch
 *
 * Histórico dos check-ins do Wellhub, já vinculados à matrícula do aluno.
 *
 * POR QUE ESTE ARQUIVO EXISTE
 *   O poller confirmava o check-in no portal e esquecia. O relatório do ciclo
 *   vivia só em memória (`estado.ultimoCiclo`) e o aviso por e-mail era a única
 *   marca de que alguém treinou — quer dizer, no dia seguinte não havia como
 *   responder "quantas vezes o Fulano veio esta semana?". Sem essa resposta não
 *   dá para cobrar frequência antes do fim do mês, que é o objetivo.
 *
 * FONTE DOS DADOS
 *   `wellhub-portal.listarValidados()`, lido a cada ciclo do poller. É a lista
 *   que o próprio portal considera validada — cobre tanto o que o modo
 *   automático confirmou quanto o que você confirmou na mão pelo site. Gravar
 *   apenas o que o nosso lado confirmou deixaria buracos nos dias em que o
 *   poller estava em modo aviso.
 *
 * CHAVE DE DEDUPLICAÇÃO: `gympassId|data`
 *   Um aluno por dia. O poller roda a cada 15 min e relê a mesma lista de
 *   validados o dia inteiro; sem essa chave, cada ciclo criaria uma linha nova
 *   e o aluno pareceria ter treinado 30 vezes. Dois treinos do mesmo aluno no
 *   mesmo dia contam como um — que é exatamente como a frequência semanal
 *   combinada é medida.
 *
 * VÍNCULO COM A MATRÍCULA
 *   O Wellhub identifica por `gympass_id`; nós, por nome. A ponte é o campo
 *   `gympassId` da matrícula: quando ele existe, o vínculo é exato. Quando não,
 *   tentamos casar pelo nome normalizado e, dando certo com um único candidato,
 *   gravamos o `gympassId` na matrícula — o casamento por nome acontece uma vez
 *   e daí em diante o vínculo é pelo id. Nome ambíguo ou desconhecido fica sem
 *   vínculo e aparece na tela para você resolver na mão; adivinhar aqui
 *   creditaria treino na ficha errada.
 *
 * Persistência: arquivo próprio no volume + backup no repositório privado,
 * mesma mecânica de `matriculas.json`.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const backupGithub = require('./backup-github');
const grade = require('./grade');
const matriculas = require('./matriculas-store');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ARQUIVO = path.join(DIR, 'checkins.json');
const CAMINHO_BACKUP = process.env.GITHUB_PATH_CHECKINS || 'teamrausch/checkins.json';
const CAMINHO_HISTORICO = process.env.GITHUB_PATH_CHECKINS_HISTORICO
  || 'teamrausch/checkins-historico.json';
const FUSO = process.env.TZ_ESTUDIO || 'America/Sao_Paulo';
const RETENCAO_DIAS = Number(process.env.CHECKINS_RETENCAO_DIAS || 400);

const backup = backupGithub.criar(CAMINHO_BACKUP, 'Check-ins Wellhub');
const fonteHistorico = backupGithub.criar(CAMINHO_HISTORICO, 'Histórico de check-ins');

let dados = { checkins: [] };
let pendente = null;
let semeando = false;

function log(...a) { console.log('[checkins]', ...a); }

/* --------------------------- disco e backup ------------------------------ */

function carregar() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    if (fs.existsSync(ARQUIVO)) {
      const lido = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
      dados.checkins = Array.isArray(lido.checkins) ? lido.checkins : [];
    }
  } catch (erro) {
    console.error('[checkins] não consegui ler, começando vazio:', erro.message);
  }
}

function montar() {
  return JSON.stringify({
    atualizadoEm: new Date().toISOString(),
    total: dados.checkins.length,
    checkins: dados.checkins,
  }, null, 2);
}

function gravar() {
  if (!pendente) {
    pendente = setTimeout(() => {
      pendente = null;
      try {
        fs.mkdirSync(DIR, { recursive: true });
        const temp = `${ARQUIVO}.tmp`;
        fs.writeFileSync(temp, montar());
        fs.renameSync(temp, ARQUIVO);
      } catch (erro) {
        console.error('[checkins] falha ao gravar:', erro.message);
      }
    }, 300);
    if (pendente.unref) pendente.unref();
  }
  backup.sincronizar(montar);
}

/** Volume vazio no primeiro boot: puxa o histórico do backup, como as matrículas. */
async function semear() {
  if (semeando || dados.checkins.length || !backup.ligado) return;
  semeando = true;
  try {
    const remoto = await backup.baixar();
    if (!remoto || !Array.isArray(remoto.checkins) || !remoto.checkins.length) {
      log('sem backup para semear; histórico começa vazio.');
      return;
    }
    if (dados.checkins.length) return;   // chegou check-in enquanto baixava
    dados.checkins = remoto.checkins;
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(ARQUIVO, montar());
    log(`histórico semeado do backup: ${dados.checkins.length} check-ins.`);
  } catch (erro) {
    console.error('[checkins] falha ao semear do backup:', erro.message);
  } finally {
    semeando = false;
  }
}

/* ------------------------------ data e hora ------------------------------ */

/**
 * Data e hora no fuso do estúdio. O portal devolve UTC; um check-in das 21h de
 * São Paulo chega como 00h do dia seguinte, e sem converter ele cairia na
 * semana errada.
 */
function dataLocal(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return hojeLocal();
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

function horaLocal(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: FUSO, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
}

function hojeLocal() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/**
 * Nome do aluno lido da ficha, e não do que ficou congelado no check-in.
 *
 * `nomeMatricula` é gravado no momento do vínculo. Quando a ficha é renomeada
 * depois — correção sua, nome novo do portal, a régua de caixa do boot — o
 * histórico continuaria mostrando o nome velho ao lado do novo. Ler da ficha na
 * hora de listar mantém a tela sempre coerente, sem varrer o histórico inteiro.
 */
function comNomeAtual(c) {
  if (!c.matriculaId) return c;
  const m = matriculas.porId(c.matriculaId);
  if (!m || m.nome === c.nomeMatricula) return c;
  return { ...c, nomeMatricula: m.nome };
}

/* ------------------------------- vínculo --------------------------------- */

/**
 * Nome comparável: sem acento, sem pontuação, minúsculo, espaço único.
 * O portal escreve "MARIA DA SILVA", a planilha escreveu "Maria da Silva" —
 * são a mesma pessoa e precisam casar.
 */
function normalizarNome(nome) {
  return String(nome || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .trim().replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * Nomes pelos quais uma ficha pode ser reconhecida no portal.
 *
 * Normalmente é só o nome do aluno. Quando o plano está no nome de outra pessoa,
 * `titularWellhub` guarda o nome que o Wellhub manda — é sempre 1 para 1, uma
 * conta para um aluno, então esse nome identifica a ficha sem ambiguidade.
 */
function nomesDaFicha(m) {
  return [
    { nome: normalizarNome(m.nome), via: 'nome' },
    { nome: normalizarNome(m.titularWellhub), via: 'titular' },
  ].filter((x) => x.nome);
}

/** Primeiro + último nome, que é como o portal costuma abreviar. */
function abreviar(nomeNormalizado) {
  const p = String(nomeNormalizado || '').split(' ');
  return p.length >= 2 ? `${p[0]} ${p[p.length - 1]}` : null;
}

/** Por qual dos nomes da ficha o alvo casou — ou null. */
function viaNome(m, alvo, curto = false) {
  const achado = nomesDaFicha(m)
    .find((x) => (curto ? abreviar(x.nome) : x.nome) === alvo);
  return achado ? achado.via : null;
}

/**
 * Acha a matrícula de um check-in. Devolve `{ matricula, via }` ou null.
 *
 * Ordem: id do Wellhub já gravado na matrícula, depois nome exato — do aluno ou
 * do titular da conta. O nome só vale quando é de um único aluno ativo — dois
 * "Ana Paula" na base derrubam a tentativa em vez de sortear um.
 */
function acharMatricula(reg) {
  const lista = matriculas.listar();

  if (reg.gympassId) {
    const porId = lista.find((m) => String(m.gympassId || '') === String(reg.gympassId));
    if (porId) return { matricula: porId, via: 'wellhub-id' };
  }

  const alvo = normalizarNome(reg.nome);
  if (!alvo) return null;

  const candidatos = lista.filter((m) => m.ativo && viaNome(m, alvo));
  if (candidatos.length === 1) {
    return { matricula: candidatos[0], via: viaNome(candidatos[0], alvo) };
  }

  // Nome não bate exato: tenta primeiro + último sobrenome, que é como o
  // portal costuma abreviar. Ainda exigindo candidato único.
  const curto = abreviar(alvo);
  if (curto) {
    const porCurto = lista.filter((m) => m.ativo && viaNome(m, curto, true));
    if (porCurto.length === 1) {
      return { matricula: porCurto[0], via: viaNome(porCurto[0], curto, true) };
    }
  }

  // Ficha cadastrada com o nome curto: "Aender" contra "Aender Soares Quaresma".
  // Boa parte da base veio assim da planilha do estúdio, e essas fichas nunca
  // casariam pelas duas regras acima — o aluno treinaria o mês inteiro e todo
  // check-in dele ficaria órfão.
  //
  // A regra é conter, não parecer: todas as palavras da ficha têm de aparecer
  // no nome do portal. "Erika Ribeiro" casa com "Erika Cristina Silva Ribeiro";
  // "Erika Fonseca" não. Candidato único, senão desiste — duas fichas "Ana" na
  // base derrubam a tentativa em vez de creditar treino na pessoa errada.
  //
  // Só entre fichas Wellhub: mensalista não faz check-in no portal, e sem esse
  // filtro uma ficha "Regina" abraçaria a "Sonia Regina" de outra pessoa.
  const palavrasAlvo = new Set(alvo.split(' '));
  const contido = (nome) => {
    const p = String(nome || '').split(' ').filter(Boolean);
    return p.length > 0 && p.every((x) => palavrasAlvo.has(x));
  };
  const porConter = lista.filter((m) => m.ativo && m.vinculo === 'wellhub' &&
    nomesDaFicha(m).some((x) => contido(x.nome)));
  if (porConter.length === 1) {
    const achado = nomesDaFicha(porConter[0]).find((x) => contido(x.nome));
    return { matricula: porConter[0], via: achado.via };
  }

  return null;
}

/** Aplica o vínculo no registro e devolve true se conseguiu. */
function vincularAutomatico(reg) {
  const achado = acharMatricula(reg);
  if (!achado) {
    reg.matriculaId = null;
    reg.vinculadoPor = null;
    return false;
  }
  reg.matriculaId = achado.matricula.id;
  reg.vinculadoPor = achado.via;

  // Casou pelo nome (do aluno ou do titular da conta): grava o id do Wellhub na
  // matrícula para que a próxima vez seja exata. É o que transforma um palpite
  // bom em vínculo permanente.
  if (achado.via !== 'wellhub-id' && reg.gympassId && !achado.matricula.gympassId) {
    matriculas.definirGympassId(achado.matricula.id, reg.gympassId);
    log(`${achado.matricula.nome}: Wellhub ID ${reg.gympassId} vinculado pelo ${achado.via === 'titular' ? 'titular da conta' : 'nome'}.`);
  }

  // Casou pelo titular: o nome que veio no check-in é de quem assina o plano,
  // não do aluno. Adotá-lo trocaria o nome da ficha pelo da outra pessoa.
  if (achado.via !== 'titular') adotarNome(achado.matricula.id, reg.nome);
  // Lido depois de adotarNome, senão o histórico guardaria o nome antigo.
  reg.nomeMatricula = (matriculas.porId(achado.matricula.id) || achado.matricula).nome;
  return true;
}

/**
 * Passa o nome do portal para a ficha do aluno.
 *
 * A base veio de planilha, com apelidos e abreviações; o Wellhub tem o nome do
 * cadastro, que é o que aparece na fila de validação. Manter os dois iguais é o
 * que permite conferir a tela do portal contra a nossa sem tradução mental.
 *
 * `matriculas.renomearDoWellhub` aplica cada nome do portal uma única vez, então
 * chamar isto em todo check-in não desfaz correção feita por você na tela.
 */
function adotarNome(matriculaId, nomeDoPortal) {
  if (!nomeDoPortal) return;
  const r = matriculas.renomearDoWellhub(matriculaId, nomeDoPortal);
  if (r.mudou) log(`renomeado pelo Wellhub: "${r.de}" → "${r.para}".`);
  // Colisão de nome é matrícula duplicada, e some do log num dia movimentado se
  // não for dita alto: o vínculo continua valendo, só o nome não trocou.
  else if (r.ok === false) log(`nome do portal não aplicado — ${r.motivo}`);
}

/* ------------------------------- registro -------------------------------- */

function novoId() {
  return 'c' + crypto.randomBytes(6).toString('hex');
}

function chave(gympassId, data) {
  return `${String(gympassId || '')}|${data}`;
}

function existente(gympassId, data) {
  const k = chave(gympassId, data);
  return dados.checkins.find((c) => chave(c.gympassId, c.data) === k) || null;
}

/**
 * Grava um check-in validado. Idempotente pela chave `gympassId|data`.
 * @returns {{ novo: boolean, checkin: object }}
 */
function registrar(bruto, origem = 'portal') {
  const gympassId = String(bruto.gympassId ?? bruto.gympass_id ?? '').trim() || null;
  const criadoEm = bruto.criadoEm || bruto.checked_in_at || new Date().toISOString();
  const data = bruto.data || dataLocal(criadoEm);
  // A planilha do Wellhub já vem com data e hora locais; converter de novo
  // jogaria o check-in das 05:54 para 02:54.
  const hora = bruto.hora || horaLocal(criadoEm);

  const jaTem = gympassId ? existente(gympassId, data) : null;
  if (jaTem) {
    // Registro antigo sem vínculo ganha uma nova chance: a matrícula pode ter
    // sido cadastrada depois do check-in.
    if (!jaTem.matriculaId && vincularAutomatico(jaTem)) gravar();
    return { novo: false, checkin: jaTem };
  }

  const reg = {
    id: novoId(),
    gympassId,
    nome: bruto.nome || null,
    produto: bruto.produto || null,
    data,
    hora,
    criadoEm,
    registradoEm: new Date().toISOString(),
    origem,
    primeiraVez: Boolean(bruto.primeiraVez),
    matriculaId: null,
    nomeMatricula: null,
    vinculadoPor: null,
  };
  vincularAutomatico(reg);

  dados.checkins.push(reg);
  gravar();
  return { novo: true, checkin: reg };
}

/**
 * Grava a lista inteira que veio do portal.
 * @returns {{ novos: number, repetidos: number, semVinculo: number, registros: object[] }}
 */
function registrarLote(lista, origem = 'portal') {
  const registros = [];
  let novos = 0;
  let repetidos = 0;

  for (const item of lista || []) {
    const r = registrar(item, origem);
    if (r.novo) { novos += 1; registros.push(r.checkin); } else repetidos += 1;
  }

  const semVinculo = registros.filter((c) => !c.matriculaId).length;
  if (novos) log(`${novos} check-in(s) novo(s), ${repetidos} repetido(s), ${semVinculo} sem vínculo.`);
  return { novos, repetidos, semVinculo, registros };
}

/** Um check-in pelo id — a tela precisa dele para abrir a ficha do dono. */
function porId(id) {
  return dados.checkins.find((c) => c.id === id) || null;
}

/**
 * Vínculo manual, feito na tela quando o nome não casou sozinho.
 *
 * `comoTitular` é o caso da conta em nome de outra pessoa: em vez de rebatizar
 * o aluno com o nome que veio do portal, esse nome vai para `titularWellhub` e
 * o nome da ficha fica travado.
 */
function vincular(id, matriculaId, { comoTitular = false } = {}) {
  const c = dados.checkins.find((x) => x.id === id);
  if (!c) return { ok: false, motivo: 'Check-in não encontrado.' };
  const m = matriculas.porId(matriculaId);
  if (!m) return { ok: false, motivo: 'Matrícula não encontrada.' };

  c.matriculaId = m.id;
  c.vinculadoPor = 'manual';

  // Vincular na mão vale para o futuro também: sem gravar o id na matrícula,
  // o mesmo aluno voltaria sem vínculo no dia seguinte.
  if (c.gympassId && String(m.gympassId || '') !== String(c.gympassId)) {
    matriculas.definirGympassId(m.id, c.gympassId);
  }

  // Vincular na mão é justamente o caso em que os nomes não batiam. Adotar o do
  // portal aqui é o que faz o próximo check-in casar sozinho.
  // `m` é a referência viva do store: renomear altera `m.nome` no lugar, então
  // o nome anterior é copiado antes da chamada.
  const nomeAntes = m.nome;
  if (comoTitular) {
    matriculas.definirTitular(m.id, c.nome);
    log(`${m.nome}: conta do Wellhub em nome de ${c.nome} — nome da ficha travado.`);
  } else {
    adotarNome(m.id, c.nome);
  }
  const nomeAtual = m.nome;
  c.nomeMatricula = nomeAtual;

  // Os outros check-ins órfãos do mesmo id passam a apontar para a matrícula.
  let arrastados = 0;
  for (const outro of dados.checkins) {
    if (outro.id === c.id || outro.matriculaId) continue;
    if (c.gympassId && String(outro.gympassId) === String(c.gympassId)) {
      outro.matriculaId = m.id;
      outro.nomeMatricula = nomeAtual;
      outro.vinculadoPor = 'manual';
      arrastados += 1;
    }
  }

  gravar();
  return {
    ok: true, checkin: c, arrastados, nome: nomeAtual,
    renomeado: nomeAtual !== nomeAntes, titular: comoTitular ? c.nome : null,
  };
}

/** Desfaz o vínculo (id do Wellhub trocado de dono, erro de digitação). */
function desvincular(id) {
  const c = dados.checkins.find((x) => x.id === id);
  if (!c) return { ok: false, motivo: 'Check-in não encontrado.' };
  c.matriculaId = null;
  c.nomeMatricula = null;
  c.vinculadoPor = null;
  gravar();
  return { ok: true, checkin: c };
}

/**
 * Varre o histórico e aplica em cada ficha o nome que o Wellhub usa hoje.
 *
 * A adoção de nome passou a valer no momento do vínculo, então quem já estava
 * vinculado antes só seria renomeado no próximo treino — a base levaria semanas
 * para ficar uniforme, e quem parou de treinar nunca chegaria lá. Esta varredura
 * resolve todos de uma vez.
 *
 * USA O CHECK-IN MAIS RECENTE DE CADA ALUNO
 *   Aplicar em ordem cronológica faria o nome mais antigo do portal vencer o
 *   mais novo: cada chamada reescreve `nomeWellhub`, e a seguinte veria um nome
 *   diferente do gravado e trocaria de novo. Uma passada por matrícula, com o
 *   registro mais recente, é o que produz o nome atual.
 *
 * Correção sua feita na tela continua de pé quando o portal não mudou o nome —
 * quem decide isso é `renomearDoWellhub`, não esta função.
 */
function aplicarNomesDoPortal() {
  const maisRecente = new Map();
  for (const c of dados.checkins) {
    if (!c.matriculaId || !c.nome) continue;
    const atual = maisRecente.get(c.matriculaId);
    if (!atual || c.data > atual.data) maisRecente.set(c.matriculaId, c);
  }

  const trocas = [];
  const recusados = [];
  for (const [matriculaId, c] of maisRecente) {
    const r = matriculas.renomearDoWellhub(matriculaId, c.nome);
    if (r.mudou) trocas.push({ matriculaId, de: r.de, para: r.para });
    else if (r.ok === false) recusados.push({ matriculaId, nome: c.nome, motivo: r.motivo });
  }

  // O nome guardado no histórico acompanha, senão a tela de check-ins mostraria
  // o nome velho ao lado do novo.
  let atualizados = 0;
  for (const c of dados.checkins) {
    if (!c.matriculaId) continue;
    const m = matriculas.porId(c.matriculaId);
    if (m && c.nomeMatricula !== m.nome) { c.nomeMatricula = m.nome; atualizados += 1; }
  }

  if (trocas.length || atualizados) {
    gravar();
    log(`varredura: ${trocas.length} ficha(s) renomeada(s), `
      + `${atualizados} registro(s) do histórico atualizado(s).`);
  }
  for (const r of recusados) log(`varredura: ${r.nome} não aplicado — ${r.motivo}`);

  return { avaliados: maisRecente.size, trocas, recusados, atualizados };
}

/**
 * Passa de novo pelos órfãos. Use depois de cadastrar alunos novos ou de
 * corrigir nomes: nada precisa ser reimportado do portal.
 */
function revincularOrfaos() {
  let ligados = 0;
  for (const c of dados.checkins) {
    if (c.matriculaId) continue;
    if (vincularAutomatico(c)) ligados += 1;
  }
  if (ligados) gravar();
  return { ligados, restantes: dados.checkins.filter((c) => !c.matriculaId).length };
}

/* ---------------------------- backfill do mês ----------------------------- */

/**
 * Traz para o histórico os check-ins que aconteceram antes do poller existir.
 *
 * O poller só começou a gravar em 25/08; o relatório do portal ("Detalhes do
 * check-in") tem o mês inteiro. Sem este backfill não há como responder quantos
 * treinos faltam até o dia 31 — metade do mês simplesmente não existe na base.
 *
 * FONTE: `teamrausch/checkins-historico.json` no repositório privado, no
 * formato `{ checkins: [{ gympassId, nome, data, hora, produto, criadoEm }] }`.
 * Editar o backup `checkins.json` direto não funcionaria: o volume é a fonte de
 * verdade e o próximo `gravar()` sobrescreveria o que fosse colocado lá à mão.
 *
 * SEGURO DE RODAR DE NOVO: `registrar` deduplica por `gympassId|data`, então
 * repetir a importação não cria linha nova nem desfaz vínculo feito na tela.
 * Roda no boot e sob demanda pelo endpoint `/wellhub/checkins/importar-historico`.
 */
async function importarHistorico() {
  if (!fonteHistorico.ligado) {
    return { ok: false, motivo: 'Defina GITHUB_TOKEN e GITHUB_REPO para ler o histórico.' };
  }
  const remoto = await fonteHistorico.baixar();
  const lista = remoto && Array.isArray(remoto.checkins) ? remoto.checkins : [];
  if (!lista.length) return { ok: true, noArquivo: 0, novos: 0, repetidos: 0, semVinculo: 0 };

  const r = registrarLote(lista, 'planilha');
  const orfaos = dados.checkins.filter((x) => !x.matriculaId);
  const resultado = {
    ok: true,
    noArquivo: lista.length,
    novos: r.novos,
    repetidos: r.repetidos,
    semVinculo: r.semVinculo,
    orfaosNaBase: orfaos.length,
    // Uma linha por pessoa, não por check-in: são 20 nomes para resolver na
    // tela, não 200 registros para ler no log.
    pessoasSemVinculo: [...new Map(orfaos.map((x) => [String(x.gympassId), x.nome])).entries()]
      .map(([gympassId, nome]) => ({ gympassId, nome }))
      .sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR')),
  };
  log('histórico:', JSON.stringify({ ...resultado, pessoasSemVinculo: resultado.pessoasSemVinculo.length }));
  return resultado;
}

/* -------------------- pessoas do portal e reatribuição -------------------- */

/**
 * Uma linha por pessoa vista no portal, com a ficha em que ela está hoje.
 *
 * É o que a ficha do aluno precisa para oferecer uma lista em vez de um campo
 * de digitar número: o Wellhub ID tem treze dígitos e ninguém decora, então na
 * prática o vínculo só era feito quando um check-in órfão aparecia na aba
 * Frequência. Quem já está em outra ficha aparece igual, com o dono atual — é
 * assim que se conserta um vínculo errado sem sair da tela.
 */
function pessoas() {
  const mapa = new Map();
  for (const c of dados.checkins) {
    const gid = String(c.gympassId || '');
    if (!gid) continue;
    const atual = mapa.get(gid) || {
      gympassId: gid, nome: c.nome, quantos: 0,
      primeira: c.data, ultima: c.data, matriculaId: null, nomeMatricula: null,
    };
    atual.quantos += 1;
    if (c.data < atual.primeira) atual.primeira = c.data;
    // Nome do check-in mais recente: o portal corrige cadastro, e o nome velho
    // deixaria a lista fora de sincronia com a tela de validação.
    if (c.data >= atual.ultima) { atual.ultima = c.data; atual.nome = c.nome; }
    if (c.matriculaId) {
      atual.matriculaId = c.matriculaId;
      const m = matriculas.porId(c.matriculaId);
      atual.nomeMatricula = m ? m.nome : c.nomeMatricula;
    }
    mapa.set(gid, atual);
  }
  return [...mapa.values()]
    .sort((a, b) => String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR'));
}

/**
 * Aponta TODOS os check-ins de um Wellhub ID para uma ficha — ou solta todos,
 * quando `matriculaId` é null.
 *
 * Diferente de `vincular`, que parte de um check-in e arrasta os órfãos do
 * mesmo ID: aqui o ponto de partida é a pessoa, e registros que já estavam em
 * outra ficha vêm junto. É o caso de duas pessoas que caíram na mesma ficha —
 * sem isto, os check-ins da errada continuariam contando para a certa.
 *
 * Não mexe no nome da ficha. Quem chama daqui é a tela de cadastro, onde o nome
 * é digitado por você; adotar o do portal desfaria a correção que acabou de ser
 * feita.
 */
function reatribuir(gympassId, matriculaId) {
  const gid = String(gympassId || '').trim();
  if (!gid) return { ok: false, motivo: 'Informe o Wellhub ID.' };

  const m = matriculaId ? matriculas.porId(matriculaId) : null;
  if (matriculaId && !m) return { ok: false, motivo: 'Matrícula não encontrada.' };

  let movidos = 0;
  for (const c of dados.checkins) {
    if (String(c.gympassId || '') !== gid) continue;
    if (c.matriculaId === (m ? m.id : null)) continue;
    c.matriculaId = m ? m.id : null;
    c.nomeMatricula = m ? m.nome : null;
    c.vinculadoPor = m ? 'manual' : null;
    movidos += 1;
  }
  if (movidos) gravar();
  return {
    ok: true, movidos, gympassId: gid,
    matriculaId: m ? m.id : null, nome: m ? m.nome : null,
    total: dados.checkins.filter((c) => String(c.gympassId || '') === gid).length,
  };
}

/**
 * Leva para outra ficha todos os check-ins de uma matrícula que deixou de
 * existir. É o par da mesclagem de fichas duplicadas: `reatribuir` parte do
 * Wellhub ID, e aqui o ponto de partida é a ficha — inclusive os registros
 * antigos, que podem ter vindo da planilha sem ID nenhum.
 *
 * Aproveita para reescrever o nome guardado em todos os check-ins da ficha
 * final: a mesclagem costuma trocar o nome dela, e a lista do portal mostraria
 * o antigo até o próximo check-in.
 */
function moverMatricula(deId, paraId) {
  const m = matriculas.porId(paraId);
  if (!m) return { ok: false, motivo: 'Matrícula não encontrada.' };

  let movidos = 0;
  for (const c of dados.checkins) {
    if (c.matriculaId === deId && deId !== paraId) {
      c.matriculaId = m.id;
      c.vinculadoPor = c.vinculadoPor || 'manual';
      movidos += 1;
    }
    if (c.matriculaId === m.id) c.nomeMatricula = m.nome;
  }
  gravar();
  return { ok: true, movidos, nome: m.nome };
}

/** Quantos check-ins estão hoje nesta ficha — a tela mostra ao lado do vínculo. */
function quantosDaMatricula(matriculaId) {
  return dados.checkins.filter((c) => c.matriculaId === matriculaId).length;
}

/* ------------------------------- consultas ------------------------------- */

function listar({ de, ate, matriculaId, gympassId, semVinculo, limite = 500 } = {}) {
  return dados.checkins
    .map(comNomeAtual)
    .filter((c) =>
      (!de || c.data >= de) &&
      (!ate || c.data <= ate) &&
      (!matriculaId || c.matriculaId === matriculaId) &&
      (!gympassId || String(c.gympassId) === String(gympassId)) &&
      (!semVinculo || !c.matriculaId))
    .sort((a, b) => b.data.localeCompare(a.data) || String(b.hora).localeCompare(String(a.hora)))
    .slice(0, limite);
}

/** Só as datas em que o aluno treinou, do mais antigo para o mais novo. */
function datasDaMatricula(matriculaId, { de, ate } = {}) {
  return dados.checkins
    .filter((c) => c.matriculaId === matriculaId &&
      (!de || c.data >= de) && (!ate || c.data <= ate))
    .map((c) => c.data)
    .sort();
}

/** Mapa matriculaId → datas, montado uma vez para não varrer a base por aluno. */
function mapaPorMatricula({ de, ate } = {}) {
  const mapa = new Map();
  for (const c of dados.checkins) {
    if (!c.matriculaId) continue;
    if (de && c.data < de) continue;
    if (ate && c.data > ate) continue;
    if (!mapa.has(c.matriculaId)) mapa.set(c.matriculaId, []);
    mapa.get(c.matriculaId).push(c.data);
  }
  for (const lista of mapa.values()) lista.sort();
  return mapa;
}

/**
 * Produto do Wellhub mais recente de cada ficha — a base da previsão de receita.
 *
 * Funcional e Crosstraining pagam valores diferentes, então projetar o que
 * ainda falta no mês exige saber o que o aluno costuma marcar. O critério é o
 * último check-in dele: quem trocou de plano em maio não pode ficar preso ao
 * preço de janeiro. Ficha sem check-in nenhum não entra no mapa e a projeção
 * cai no valor mais baixo, que erra para baixo de propósito.
 */
function produtoPorMatricula() {
  const mapa = new Map();
  const quando = new Map();
  for (const c of dados.checkins) {
    if (!c.matriculaId || !c.produto) continue;
    const carimbo = `${c.data} ${c.hora || ''}`;
    if (!quando.has(c.matriculaId) || carimbo > quando.get(c.matriculaId)) {
      quando.set(c.matriculaId, carimbo);
      mapa.set(c.matriculaId, c.produto);
    }
  }
  return mapa;
}

function ultimoDaMatricula(matriculaId) {
  const meus = dados.checkins.filter((c) => c.matriculaId === matriculaId);
  if (!meus.length) return null;
  return meus.sort((a, b) => b.data.localeCompare(a.data))[0];
}

function resumo() {
  const hoje = hojeLocal();
  const semana = grade.somarDias(hoje, -6);
  const naSemana = dados.checkins.filter((c) => c.data >= semana);
  return {
    total: dados.checkins.length,
    hoje: dados.checkins.filter((c) => c.data === hoje).length,
    ultimos7: naSemana.length,
    semVinculo: dados.checkins.filter((c) => !c.matriculaId).length,
    semVinculo7: naSemana.filter((c) => !c.matriculaId).length,
    primeiroDia: dados.checkins.length
      ? dados.checkins.reduce((a, c) => (c.data < a ? c.data : a), hoje) : null,
  };
}

/** Um pouco mais de um ano de histórico: o suficiente para comparar temporadas. */
function limparAntigos(dias = RETENCAO_DIAS) {
  const corte = grade.somarDias(hojeLocal(), -dias);
  const antes = dados.checkins.length;
  dados.checkins = dados.checkins.filter((c) => c.data >= corte);
  if (dados.checkins.length !== antes) gravar();
}

carregar();
// Depois da semeadura, porque num volume vazio o histórico chega do backup e a
// varredura precisa dele em mãos. Num volume já povoado o `semear` sai na hora
// e o `then` roda em seguida do mesmo jeito.
semear()
  // Antes da varredura de nomes: o backfill traz o nome do portal de quem só
  // treinou na primeira quinzena, e a varredura precisa dele em mãos.
  .then(() => importarHistorico().catch((e) => {
    console.error('[checkins] backfill do histórico falhou:', e.message);
  }))
  .then(() => {
    try {
      if (dados.checkins.length) aplicarNomesDoPortal();
    } catch (e) {
      console.error('[checkins] varredura de nomes falhou:', e.message);
    }
  });
setInterval(() => limparAntigos(), 24 * 3600000).unref();

module.exports = {
  registrar, registrarLote, porId, vincular, desvincular, revincularOrfaos,
  importarHistorico, pessoas, reatribuir, moverMatricula, quantosDaMatricula,
  listar, datasDaMatricula, mapaPorMatricula, ultimoDaMatricula, aplicarNomesDoPortal,
  produtoPorMatricula,
  resumo, normalizarNome, dataLocal, hojeLocal, backup,
};
