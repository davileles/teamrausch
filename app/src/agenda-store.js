'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const backup = require('./alunos-github');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ARQUIVO = path.join(DIR, 'agenda.json');

let dados = { alunos: {}, sessoes: {}, codigos: {}, agendamentos: [], presencas: [] };
let pendente = null;

function carregar() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    if (fs.existsSync(ARQUIVO)) {
      dados = { ...dados, ...JSON.parse(fs.readFileSync(ARQUIVO, 'utf8')) };
    }
  } catch (erro) {
    console.error('[agenda-store] não consegui ler, começando vazio:', erro.message);
  }
}

function gravar() {
  if (pendente) return;
  pendente = setTimeout(() => {
    pendente = null;
    try {
      fs.mkdirSync(DIR, { recursive: true });
      const temp = `${ARQUIVO}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(dados, null, 2));
      fs.renameSync(temp, ARQUIVO);
    } catch (erro) {
      console.error('[agenda-store] falha ao gravar:', erro.message);
    }
  }, 300);
}

/* ----------------------------- alunos ----------------------------------- */

function aluno(telefone) {
  return dados.alunos[telefone] || null;
}

function salvarAluno(telefone, campos = {}) {
  const atual = dados.alunos[telefone] || {
    telefone,
    nome: null,
    aniversario: null,   // 'MM-DD' — só dia e mês, sem ano
    criadoEm: new Date().toISOString(),
    bloqueado: false,
  };
  dados.alunos[telefone] = { ...atual, ...campos };
  gravar();
  backup.sincronizar(listarAlunos);
  return dados.alunos[telefone];
}

/**
 * Troca o telefone de um aluno. O telefone é a chave do cadastro, então é
 * preciso mover a ficha, reetiquetar os agendamentos e derrubar as sessões
 * abertas com o número antigo — senão a pessoa fica logada num cadastro que
 * não existe mais.
 */
function trocarTelefone(antigo, novo) {
  const ficha = dados.alunos[antigo];
  if (!ficha) return { ok: false, motivo: 'Aluno não encontrado.' };
  if (antigo === novo) return { ok: true, aluno: ficha };
  if (dados.alunos[novo]) return { ok: false, motivo: 'Já existe um aluno com esse telefone.' };

  dados.alunos[novo] = { ...ficha, telefone: novo };
  delete dados.alunos[antigo];

  for (const a of dados.agendamentos) {
    if (a.telefone === antigo) a.telefone = novo;
  }
  for (const [t, s] of Object.entries(dados.sessoes)) {
    if (s.telefone === antigo) delete dados.sessoes[t];
  }
  delete dados.codigos[antigo];

  gravar();
  backup.sincronizar(listarAlunos);
  return { ok: true, aluno: dados.alunos[novo] };
}

/**
 * Alunos cujo telefone termina nestes dígitos.
 *
 * É como o totem da entrada encontra quem está chegando: quatro dígitos são
 * rápidos de digitar de pé e com a bolsa na mão, e a colisão — duas pessoas com
 * o mesmo final — é resolvida na tela seguinte, escolhendo o nome. Menos de
 * quatro dígitos não busca nada: com dois ou três a lista viraria meia turma.
 *
 * Aluno bloqueado fica de fora: se o acesso dele está suspenso, aparecer no
 * totem só produziria uma recusa constrangedora na frente de quem espera.
 */
function alunosPorFinal(final) {
  const digitos = String(final || '').replace(/\D/g, '');
  if (digitos.length < 4) return [];
  return listarAlunos().filter((a) =>
    !a.bloqueado && String(a.telefone || '').endsWith(digitos));
}

function listarAlunos() {
  return Object.values(dados.alunos).sort((a, b) =>
    (a.nome || a.telefone).localeCompare(b.nome || b.telefone));
}

function removerAluno(telefone) {
  delete dados.alunos[telefone];
  for (const [t, s] of Object.entries(dados.sessoes)) {
    if (s.telefone === telefone) delete dados.sessoes[t];
  }
  gravar();
  backup.sincronizar(listarAlunos);
}

/* ----------------------------- códigos ---------------------------------- */

function embaralhar(codigo) {
  return crypto.createHash('sha256').update(String(codigo)).digest('hex');
}

function guardarCodigo(telefone, codigo, minutos) {
  dados.codigos[telefone] = {
    hash: embaralhar(codigo),
    expiraEm: Date.now() + minutos * 60000,
    tentativas: 0,
    pedidos: [...((dados.codigos[telefone] || {}).pedidos || []), Date.now()]
      .filter((t) => t > Date.now() - 3600000),
  };
  gravar();
}

function pedidosNaUltimaHora(telefone) {
  const reg = dados.codigos[telefone];
  if (!reg) return 0;
  return (reg.pedidos || []).filter((t) => t > Date.now() - 3600000).length;
}

function conferirCodigo(telefone, codigo, maxTentativas) {
  const reg = dados.codigos[telefone];
  if (!reg) return { ok: false, motivo: 'Peça um código novo.' };
  if (Date.now() > reg.expiraEm) {
    delete dados.codigos[telefone]; gravar();
    return { ok: false, motivo: 'O código venceu. Peça outro.' };
  }
  if (reg.tentativas >= maxTentativas) {
    delete dados.codigos[telefone]; gravar();
    return { ok: false, motivo: 'Tentativas demais. Peça um código novo.' };
  }
  const informado = Buffer.from(embaralhar(codigo));
  const guardado = Buffer.from(reg.hash);
  if (informado.length !== guardado.length || !crypto.timingSafeEqual(informado, guardado)) {
    reg.tentativas += 1; gravar();
    return { ok: false, motivo: 'Código incorreto.' };
  }
  delete dados.codigos[telefone];
  gravar();
  return { ok: true };
}

/* ----------------------------- sessões ---------------------------------- */

function abrirSessao(telefone, dias) {
  const token = crypto.randomBytes(32).toString('hex');
  dados.sessoes[token] = {
    telefone,
    criadaEm: new Date().toISOString(),
    expiraEm: Date.now() + dias * 86400000,
  };
  gravar();
  return token;
}

function sessao(token) {
  const s = dados.sessoes[token];
  if (!s) return null;
  if (Date.now() > s.expiraEm) { delete dados.sessoes[token]; gravar(); return null; }
  return s;
}

function fecharSessao(token) {
  delete dados.sessoes[token];
  gravar();
}

/* --------------------------- agendamentos -------------------------------- */

function daData(data) {
  return dados.agendamentos.filter((a) => a.data === data && a.status === 'ativo');
}

function doHorario(data, hora) {
  return daData(data).filter((a) => a.hora === hora);
}

function doAluno(telefone, apartirDe) {
  return dados.agendamentos
    .filter((a) => a.telefone === telefone && a.status === 'ativo' && a.data >= apartirDe)
    .sort((x, y) => (x.data + x.hora).localeCompare(y.data + y.hora));
}

/** Todos os agendamentos ativos do aluno, do mais antigo ao mais novo. */
function historicoDoAluno(telefone) {
  return dados.agendamentos
    .filter((a) => a.telefone === telefone && a.status === 'ativo')
    .sort((x, y) => (x.data + x.hora).localeCompare(y.data + y.hora));
}

function jaTem(telefone, data, hora) {
  return doHorario(data, hora).some((a) => a.telefone === telefone);
}

function contarNoDia(telefone, data) {
  return daData(data).filter((a) => a.telefone === telefone).length;
}

function reservar({ telefone, nome, data, hora }) {
  const registro = {
    id: crypto.randomBytes(8).toString('hex'),
    telefone, nome, data, hora,
    status: 'ativo',
    criadoEm: new Date().toISOString(),
    canceladoEm: null,
  };
  dados.agendamentos.push(registro);
  gravar();
  return registro;
}

function cancelar(id, porQuem) {
  const a = dados.agendamentos.find((x) => x.id === id);
  if (!a || a.status !== 'ativo') return null;
  a.status = 'cancelado';
  a.canceladoEm = new Date().toISOString();
  a.canceladoPor = porQuem;
  gravar();
  return a;
}

function porId(id) {
  return dados.agendamentos.find((x) => x.id === id) || null;
}

/* ---------------------------- presenças ---------------------------------- *
 * A confirmação feita no tablet da entrada. Vive num array próprio, e não como
 * um campo do agendamento, porque a maior parte das aulas não tem agendamento
 * nenhum: quem treina na grade fixa da matrícula aparece na lista do dia sem
 * nunca ter reservado. Um campo em `agendamentos` cobriria só as reservas
 * avulsas e deixaria o mensalista de fora — que é justamente quem esta tela
 * existe para registrar.
 * ------------------------------------------------------------------------ */

/**
 * Registra que a pessoa apareceu. Idempotente por telefone + dia + hora: dois
 * toques no botão, ou a pessoa que volta ao tablet achando que não confirmou,
 * não viram duas presenças no mesmo treino.
 */
function registrarPresenca({ telefone, nome, data, hora, agendamentoId = null, origem = 'totem' }) {
  const jaTem = presencaDe(telefone, data, hora);
  if (jaTem) return { ok: true, repetida: true, presenca: jaTem };

  const registro = {
    id: crypto.randomBytes(8).toString('hex'),
    telefone, nome: nome || null, data, hora,
    agendamentoId,
    origem,
    criadoEm: new Date().toISOString(),
  };
  dados.presencas.push(registro);
  gravar();
  return { ok: true, repetida: false, presenca: registro };
}

function presencaDe(telefone, data, hora) {
  return dados.presencas.find((p) =>
    p.telefone === telefone && p.data === data && p.hora === hora) || null;
}

function presencasDaData(data) {
  return dados.presencas.filter((p) => p.data === data);
}

/** Todas as presenças confirmadas, opcionalmente dentro de uma janela de datas. */
function listarPresencas({ de, ate } = {}) {
  return dados.presencas.filter((p) =>
    (!de || p.data >= de) && (!ate || p.data <= ate));
}

function limparAntigos(diasParaGuardar = 180) {
  const corte = new Date(Date.now() - diasParaGuardar * 86400000).toISOString().slice(0, 10);
  const antes = dados.agendamentos.length;
  dados.agendamentos = dados.agendamentos.filter((a) => a.data >= corte);
  dados.presencas = (dados.presencas || []).filter((p) => p.data >= corte);
  for (const [t, s] of Object.entries(dados.sessoes)) {
    if (Date.now() > s.expiraEm) delete dados.sessoes[t];
  }
  if (dados.agendamentos.length !== antes) gravar();
}

carregar();
setInterval(() => limparAntigos(), 6 * 3600000).unref();

module.exports = {
  aluno, salvarAluno, listarAlunos, removerAluno, trocarTelefone, backup,
  guardarCodigo, conferirCodigo, pedidosNaUltimaHora,
  abrirSessao, sessao, fecharSessao,
  daData, doHorario, doAluno, historicoDoAluno, jaTem, contarNoDia, reservar, cancelar, porId,
  alunosPorFinal, registrarPresenca, presencaDe, presencasDaData, listarPresencas,
};
