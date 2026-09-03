'use strict';

/**
 * app/src/mensagens-store.js — davileles/teamrausch
 *
 * Modelos de mensagem e histórico do que já saiu, no volume do Railway com
 * cópia no GitHub — a mesma mecânica de `matriculas-store`.
 *
 * POR QUE O HISTÓRICO EXISTE
 *   O disparo em massa roda no navegador, uma mensagem de cada vez. Se a aba
 *   fechar no meio, sem registro no servidor não há como saber quem já recebeu
 *   — e reenviar tudo manda a mesma mensagem duas vezes para metade da base.
 *   Cada envio é gravado aqui na hora, então a tela consegue retomar de onde
 *   parou e você consegue conferir depois o que saiu para quem.
 *
 * O histórico é aparado em LIMITE_HISTORICO: é registro operacional, não
 * arquivo permanente, e um JSON que só cresce acaba lento de ler no boot.
 */

const fs = require('fs');
const path = require('path');
const backupGithub = require('./backup-github');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ARQUIVO = path.join(DIR, 'mensagens.json');
const CAMINHO_BACKUP = process.env.GITHUB_PATH_MENSAGENS || 'teamrausch/mensagens.json';
const LIMITE_HISTORICO = Number(process.env.MENSAGENS_HISTORICO_MAX || 2000);

const backup = backupGithub.criar(CAMINHO_BACKUP, 'Mensagens do estúdio');

/** Manual sai por decisão sua; os outros dois o agendador dispara sozinho. */
const MODOS = ['manual', 'programado', 'recorrente'];
/** Quem recebe. `devedores` é calculado na hora do envio, não fica congelado. */
const PUBLICOS = ['todos', 'wellhub', 'mensalista', 'devedores', 'ausentes'];
/** Só para modo `recorrente`. */
const GATILHOS = ['aniversario', 'dia_do_mes', 'dia_da_semana'];

let dados = { modelos: [], historico: [] };

/* ------------------------------ persistência ----------------------------- */

function log(...a) { console.log('[mensagens]', ...a); }

(function carregar() {
  try {
    const bruto = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
    dados.modelos = Array.isArray(bruto.modelos) ? bruto.modelos : [];
    dados.historico = Array.isArray(bruto.historico) ? bruto.historico : [];
    log(`${dados.modelos.length} modelo(s), ${dados.historico.length} envio(s) no histórico.`);
  } catch (e) { log('primeira vez: arquivo ainda não existe.'); }
})();

function montar() {
  return JSON.stringify({
    atualizadoEm: new Date().toISOString(),
    modelos: dados.modelos,
    historico: dados.historico,
  }, null, 2);
}

function gravar() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(ARQUIVO, montar());
  } catch (e) { log('não consegui gravar:', e.message); }
  backup.sincronizar(montar);
}

/**
 * Volume vazio no primeiro boot: puxa do backup. Sem isto, migrar de máquina
 * apagaria os modelos escritos à mão.
 */
async function semear() {
  if (dados.modelos.length || dados.historico.length || !backup.ligado) return;
  try {
    const remoto = await backup.baixar();
    if (!remoto) return;
    dados.modelos = Array.isArray(remoto.modelos) ? remoto.modelos : [];
    dados.historico = Array.isArray(remoto.historico) ? remoto.historico : [];
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(ARQUIVO, montar());
    log(`semeado do backup: ${dados.modelos.length} modelo(s).`);
  } catch (e) { log('não consegui semear do backup:', e.message); }
}

/* -------------------------------- modelos -------------------------------- */

function listarModelos() {
  return dados.modelos.slice().sort((a, b) =>
    String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR'));
}

function porId(id) {
  return dados.modelos.find((m) => m.id === id) || null;
}

/**
 * Valida e normaliza os campos que dependem do modo. Um modelo `recorrente`
 * sem gatilho seria disparado todo dia pelo agendador; um `programado` sem
 * data nunca sairia. Os dois casos são recusados aqui em vez de virarem
 * surpresa depois.
 */
function normalizar(campos, base = {}) {
  const nome = String(campos.nome === undefined ? base.nome : campos.nome || '').trim();
  if (!nome) return { ok: false, motivo: 'O modelo precisa de um nome.' };

  const texto = String(campos.texto === undefined ? base.texto : campos.texto || '').trim();
  if (!texto) return { ok: false, motivo: 'O modelo precisa de um texto.' };

  const modo = String(campos.modo === undefined ? (base.modo || 'manual') : campos.modo);
  if (!MODOS.includes(modo)) return { ok: false, motivo: 'Modo inválido.' };

  const publico = String(campos.publico === undefined ? (base.publico || 'todos') : campos.publico);
  if (!PUBLICOS.includes(publico)) return { ok: false, motivo: 'Público inválido.' };

  const m = {
    nome, texto, modo, publico,
    ativo: campos.ativo === undefined
      ? (base.ativo === undefined ? true : Boolean(base.ativo))
      : Boolean(campos.ativo),
    hora: null, quando: null, gatilho: null, diaDoMes: null, diaDaSemana: null,
  };

  if (modo === 'programado') {
    const quando = String(campos.quando === undefined ? base.quando : campos.quando || '').trim();
    // 'AAAA-MM-DDTHH:MM' — hora local do estúdio, que é como o campo da tela
    // devolve. Guardar em UTC aqui obrigaria a converter nos dois sentidos.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(quando)) {
      return { ok: false, motivo: 'Informe a data e a hora do envio programado.' };
    }
    m.quando = quando;
  }

  if (modo === 'recorrente') {
    const gatilho = String(campos.gatilho === undefined ? base.gatilho : campos.gatilho || '');
    if (!GATILHOS.includes(gatilho)) return { ok: false, motivo: 'Gatilho inválido.' };
    m.gatilho = gatilho;

    const hora = String(campos.hora === undefined ? (base.hora || '09:00') : campos.hora || '');
    if (!/^\d{2}:\d{2}$/.test(hora)) return { ok: false, motivo: 'Informe a hora do envio.' };
    m.hora = hora;

    if (gatilho === 'dia_do_mes') {
      const dia = Number(campos.diaDoMes === undefined ? base.diaDoMes : campos.diaDoMes);
      // Até 28: fevereiro não tem dia 30, e um envio mensal que pula um mês por
      // ano é pior do que um envio que sai sempre.
      if (!(dia >= 1 && dia <= 28)) return { ok: false, motivo: 'Dia do mês entre 1 e 28.' };
      m.diaDoMes = dia;
    }
    if (gatilho === 'dia_da_semana') {
      const dia = Number(campos.diaDaSemana === undefined ? base.diaDaSemana : campos.diaDaSemana);
      if (!(dia >= 0 && dia <= 6)) return { ok: false, motivo: 'Dia da semana inválido.' };
      m.diaDaSemana = dia;
    }
  }

  return { ok: true, modelo: m };
}

function criarModelo(campos) {
  const r = normalizar(campos);
  if (!r.ok) return r;
  const modelo = {
    id: 'MOD-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ...r.modelo,
    criadoEm: new Date().toISOString(),
    ultimoDisparoEm: null,
    ultimaMarca: null,   // 'AAAA-MM-DD' do último dia em que o agendador rodou
  };
  dados.modelos.push(modelo);
  gravar();
  return { ok: true, modelo };
}

function atualizarModelo(id, campos) {
  const atual = porId(id);
  if (!atual) return { ok: false, motivo: 'Modelo não encontrado.' };
  const r = normalizar(campos, atual);
  if (!r.ok) return r;

  // Trocar a data de um programado que já saiu deve fazê-lo sair de novo —
  // senão editar a data não teria efeito nenhum.
  const mudouAgendamento = atual.quando !== r.modelo.quando
    || atual.gatilho !== r.modelo.gatilho
    || atual.hora !== r.modelo.hora;

  Object.assign(atual, r.modelo);
  if (mudouAgendamento) { atual.ultimaMarca = null; }
  gravar();
  return { ok: true, modelo: atual };
}

function removerModelo(id) {
  const antes = dados.modelos.length;
  dados.modelos = dados.modelos.filter((m) => m.id !== id);
  if (dados.modelos.length === antes) return { ok: false, motivo: 'Modelo não encontrado.' };
  gravar();
  return { ok: true };
}

/** Chamado pelo agendador para não repetir o disparo no mesmo ciclo. */
function marcarDisparo(id, marca) {
  const m = porId(id);
  if (!m) return;
  m.ultimoDisparoEm = new Date().toISOString();
  m.ultimaMarca = marca || null;
  // Programado é de uma vez só: depois de sair, desliga sozinho em vez de
  // ficar na lista parecendo que ainda vai acontecer.
  if (m.modo === 'programado') m.ativo = false;
  gravar();
}

/* ------------------------------- histórico ------------------------------- */

/**
 * Grava um envio. `ok: false` também entra: saber que a mensagem falhou para
 * três alunos é o que permite reenviar só para eles.
 */
function registrar(envio) {
  const item = {
    id: 'ENV-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    em: new Date().toISOString(),
    matriculaId: envio.matriculaId || null,
    nome: envio.nome || null,
    telefone: envio.telefone || null,
    texto: String(envio.texto || ''),
    modeloId: envio.modeloId || null,
    modeloNome: envio.modeloNome || null,
    origem: envio.origem || 'manual',   // manual | massa | agendado
    lote: envio.lote || null,
    ok: Boolean(envio.ok),
    motivo: envio.motivo || null,
  };
  dados.historico.unshift(item);
  if (dados.historico.length > LIMITE_HISTORICO) {
    dados.historico.length = LIMITE_HISTORICO;
  }
  gravar();
  return item;
}

function historico({ limite = 200, lote = null, matriculaId = null } = {}) {
  let lista = dados.historico;
  if (lote) lista = lista.filter((h) => h.lote === lote);
  if (matriculaId) lista = lista.filter((h) => h.matriculaId === matriculaId);
  return lista.slice(0, Math.min(Number(limite) || 200, LIMITE_HISTORICO));
}

/**
 * Quem já recebeu neste lote e deu certo. É o que a tela usa para retomar um
 * disparo interrompido sem mandar a mensagem duas vezes.
 */
function jaEnviados(lote) {
  return dados.historico
    .filter((h) => h.lote === lote && h.ok && h.matriculaId)
    .map((h) => h.matriculaId);
}

/**
 * Ficha mesclada: o histórico de mensagens da duplicada passa a apontar para a
 * ficha que ficou. Sem isto, "o que já mandei para esta pessoa" ficaria partido
 * em dois, e um disparo em massa poderia repetir a mensagem para ela.
 */
function moverMatricula(deId, paraId, nome) {
  if (!deId || !paraId || deId === paraId) return { movidos: 0 };
  let movidos = 0;
  for (const h of dados.historico) {
    if (h.matriculaId !== deId) continue;
    h.matriculaId = paraId;
    if (nome) h.nome = nome;
    movidos += 1;
  }
  if (movidos) gravar();
  return { movidos };
}

function situacao() {
  return {
    modelos: dados.modelos.length,
    historico: dados.historico.length,
    backup: backup.situacao(),
  };
}

// Mesmo padrão de `matriculas-store`: o volume vazio se enche do backup
// sozinho, sem depender de ninguém lembrar de chamar isto no boot.
semear().catch((e) => log('semeadura falhou:', e.message));

module.exports = {
  semear, listarModelos, porId, criarModelo, atualizarModelo, removerModelo,
  marcarDisparo, registrar, historico, jaEnviados, moverMatricula, situacao,
  MODOS, PUBLICOS, GATILHOS,
};
