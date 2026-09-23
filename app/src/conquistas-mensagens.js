'use strict';

/**
 * app/src/conquistas-mensagens.js — davileles/teamrausch
 *
 * Manda a mensagem de parabéns quando o aluno bate um marco de aulas.
 *
 * O NÚMERO NÃO É CALCULADO AQUI
 *   Quem sabe quantas aulas cada um fez é `historico-aulas.js`, e é de
 *   propósito: a mesma conta alimenta a aba Meus dados. Duas contagens
 *   diferentes de "quantas aulas você fez" acabariam divergindo, e o aluno
 *   receberia parabéns por 50 vendo 47 na tela.
 *
 * A PRIMEIRA EXECUÇÃO NÃO ENVIA NADA
 *   Todo aluno com aulas no passado já bateu marcos. Sem esta trava, o deploy
 *   que sobe isto dispara uma mensagem para a base inteira de uma vez — e boa
 *   parte é parabéns por algo que aconteceu há dois anos. Então a primeira
 *   passada só anota o que cada um já tem e fica quieta. Daí para frente, só
 *   marco novo.
 *
 * UM MARCO POR VEZ
 *   Se alguém pular dois marcos de uma vez (importação de histórico, correção
 *   de dados), sai só o mais alto. Três parabéns seguidos no mesmo minuto não
 *   parecem carinho, parecem defeito.
 *
 * NA HORA, COM REDE DE SEGURANÇA À NOITE
 *   `gatilhos-mensagens.js` chama `rodar()` assim que entra check-in ou
 *   presença nova. A passada agendada abaixo continua e pega o que ficou.
 *
 * UMA VEZ POR DIA, DE VERDADE
 *   A marca do dia fica no volume, como no aviso de aniversariantes: cada
 *   deploy do Railway reinicia o processo, e sem ela três deploys numa noite
 *   virariam três mensagens iguais.
 */

const fs = require('fs');
const path = require('path');

const config = require('./config');
const historico = require('./historico-aulas');
const matriculas = require('./matriculas-store');
const modelos = require('./mensagens-store');
const telefone = require('./telefone');
const frequencia = require('./frequencia');
const { enviarTexto, preencher } = require('./mensageiro');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ARQUIVO = path.join(DIR, 'conquistas-avisadas.json');

function log(...a) { console.log(new Date().toISOString(), '[conquistas]', ...a); }

function dormir(ms) { return new Promise((r) => setTimeout(r, ms)); }

function cfg() {
  try { return config.ler().conquistasAviso || {}; } catch (e) { return {}; }
}

function ativo() { return cfg().ativo !== false; }

/** Lido direto da config para não criar require circular com o módulo. */
function boasVindasLigada() {
  try { return (config.ler().experimentalAviso || {}).ativo !== false; } catch (e) { return true; }
}

function hora() { return String(cfg().hora || '20:30'); }

function pausaMs() {
  let s;
  try { s = Number((config.ler().mensagens || {}).pausaSegundos); } catch (e) { s = NaN; }
  return Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : 8000;
}

function agoraHHMM() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: process.env.TZ_ESTUDIO || 'America/Sao_Paulo',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
}

/* -------------------------------- estado --------------------------------- */

let estado = { semeadoEm: null, ultimaData: null, porMatricula: {} };

(function carregar() {
  try {
    const bruto = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
    estado.semeadoEm = bruto.semeadoEm || null;
    estado.ultimaData = bruto.ultimaData || null;
    estado.porMatricula = bruto.porMatricula && typeof bruto.porMatricula === 'object'
      ? bruto.porMatricula : {};
  } catch (e) { /* primeira vez */ }
})();

function gravar() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(ARQUIVO, JSON.stringify(estado, null, 2));
  } catch (e) { log('não consegui gravar o estado:', e.message); }
}

function jaAvisados(matriculaId) {
  const lista = estado.porMatricula[matriculaId];
  return new Set(Array.isArray(lista) ? lista.map(Number) : []);
}

function anotar(matriculaId, marcos) {
  const atual = jaAvisados(matriculaId);
  for (const m of marcos) atual.add(Number(m.aulas));
  estado.porMatricula[matriculaId] = [...atual].sort((a, b) => a - b);
}

/* -------------------------------- texto ---------------------------------- */

function marcosDoConfig() {
  let lista;
  try { lista = config.ler().conquistas || []; } catch (e) { lista = []; }
  return lista
    .filter((m) => Number(m.aulas) > 0 && String(m.titulo || '').trim())
    .map((m) => ({ ...m, aulas: Number(m.aulas) }))
    .sort((a, b) => a.aulas - b.aulas);
}

function primeiroNome(nome) {
  return String(nome || '').trim().split(/\s+/)[0] || '';
}

/**
 * O texto sai do próprio marco (Configurações → Conquistas). Marco salvo antes
 * deste recurso não tem texto nenhum; aí vale o modelo geral, para a conquista
 * não nascer muda.
 */
function textoDoMarco(marco, ficha, proximo, total) {
  const molde = String(marco.mensagem || '').trim() || String(cfg().mensagemPadrao || '').trim();
  if (!molde) return null;
  return preencher(molde, {
    nome: primeiroNome(ficha.nome),
    nomeCompleto: ficha.nome || '',
    conquista: marco.titulo,
    emoji: marco.emoji || '🏅',
    aulas: marco.aulas,
    total,
    proximaConquista: proximo ? proximo.titulo : '',
    faltam: proximo ? Math.max(0, proximo.aulas - total) : '',
  });
}

/* -------------------------------- envio ---------------------------------- */

async function avisarGrupo(saiu) {
  if (cfg().avisarGrupo === false || !saiu.length) return;
  // Não vai para o grupo na hora: entra no resumo das 14h/21h
  // (`resumo-grupo.js`), para o grupo do operador não virar um rolo de avisos.
  try {
    require('./resumo-grupo').conquistas(saiu);
  } catch (e) {
    // O aviso é registro, não o trabalho: as mensagens já saíram.
    log('não consegui guardar para o resumo do grupo —', e.message);
  }
}

/**
 * Uma passada completa.
 *
 * @param {object} opcoes
 * @param {boolean} opcoes.avisar  `false` devolve o que sairia sem enviar nada.
 * @param {boolean} opcoes.semearAgora  força a anotação inicial sem envio.
 */
async function rodarAgora(opcoes = {}) {
  const simulacao = opcoes.avisar === false;

  // O acumulado precisa estar em dia antes de comparar com os marcos; na
  // primeira vez isto também semeia o histórico.
  if (!simulacao) historico.consolidar();

  const marcos = marcosDoConfig();
  if (!marcos.length) return { enviados: 0, pendentes: [], motivo: 'sem conquistas configuradas' };

  const totais = historico.totais();
  const semear = !estado.semeadoEm || opcoes.semearAgora === true;

  const pendentes = [];
  for (const ficha of matriculas.listar()) {
    if (!ficha.ativo) continue;
    const total = totais.get(ficha.id) || 0;
    if (!total) continue;

    const avisados = jaAvisados(ficha.id);
    const alcancados = marcos.filter((m) => total >= m.aulas);
    let novos = alcancados.filter((m) => !avisados.has(m.aulas));
    if (!novos.length) continue;

    // Experimental recebe a boas-vindas de `boas-vindas-experimental.js` no
    // lugar do marco de 1 aula — as duas diriam quase o mesmo no mesmo dia.
    // O marco é anotado em silêncio para não sair depois que a pessoa deixar
    // de ser experimental. Com a boas-vindas desligada, vale a conquista.
    if (ficha.experimental && boasVindasLigada()) {
      const primeira = novos.filter((m) => m.aulas === 1);
      if (primeira.length && !simulacao && !semear) anotar(ficha.id, primeira);
      novos = novos.filter((m) => m.aulas !== 1);
      if (!novos.length) continue;
    }

    if (semear) { anotar(ficha.id, novos); continue; }

    const numero = telefone.normalizar(ficha.telefone);
    const maior = novos[novos.length - 1];
    const proximo = marcos.find((m) => m.aulas > total) || null;
    pendentes.push({
      matriculaId: ficha.id,
      nome: ficha.nome,
      telefone: numero,
      total,
      conquista: maior.titulo,
      emoji: maior.emoji || '🏅',
      aulas: maior.aulas,
      novos,
      texto: textoDoMarco(maior, ficha, proximo, total),
    });
  }

  if (semear) {
    estado.semeadoEm = new Date().toISOString();
    estado.ultimaData = frequencia.hojeLocal();
    gravar();
    const quantos = Object.keys(estado.porMatricula).length;
    log(`primeira passada: ${quantos} matrícula(s) anotada(s), nenhuma mensagem enviada.`);
    return { semeado: true, enviados: 0, anotadas: quantos, pendentes: [] };
  }

  if (simulacao) return { simulacao: true, enviados: 0, pendentes };

  let enviados = 0;
  const falhas = [];
  const saiu = [];
  for (const p of pendentes) {
    // Sem telefone ou sem texto não se anota nada: assim que o cadastro for
    // corrigido, a mensagem sai na passada seguinte em vez de se perder.
    if (!p.telefone || !p.texto) {
      falhas.push({ ...p, motivo: p.telefone ? 'conquista sem texto' : 'sem telefone' });
      continue;
    }

    const r = await enviarTexto(p.telefone, p.texto);
    if (r.ok) { enviados++; saiu.push(p); anotar(p.matriculaId, p.novos); gravar(); }
    else falhas.push({ ...p, motivo: r.motivo });

    modelos.registrar({
      matriculaId: p.matriculaId, nome: p.nome, telefone: p.telefone, texto: p.texto,
      modeloId: null, modeloNome: `Conquista: ${p.conquista}`, origem: 'conquista',
      ok: r.ok, motivo: r.ok ? null : r.motivo,
    });

    await dormir(pausaMs());
  }

  if (opcoes.marcarDia !== false) estado.ultimaData = frequencia.hojeLocal();
  gravar();

  if (falhas.length) log(`${falhas.length} não saiu/saíram:`,
    falhas.map((f) => `${f.nome} (${f.motivo})`).join('; '));
  if (enviados) log(`${enviados} parabéns enviado(s).`);
  await avisarGrupo(saiu);

  return { enviados, falhas: falhas.length, pendentes, detalheFalhas: falhas };
}

/**
 * Uma passada por vez. Agora há duas portas (gatilho da aula e passada da
 * noite); se rodassem juntas, as duas veriam o mesmo aluno como pendente
 * antes de qualquer uma anotar, e ele receberia a mensagem duas vezes.
 *
 * `opcoes.marcarDia: false` (usado pelo gatilho) não encerra o dia, para a
 * passada da noite continuar como rede de segurança.
 */
let fila = Promise.resolve();
function rodar(opcoes = {}) {
  const vez = fila.then(() => rodarAgora(opcoes));
  fila = vez.catch(() => {});
  return vez;
}

/* ------------------------------ agendador -------------------------------- */

function iniciar() {
  log(`agendado: checagem a cada 5 min, disparo a partir das ${hora()}`
    + `${ativo() ? '' : ' — DESLIGADO na configuração'}.`);

  const tentar = async () => {
    if (!ativo()) return;
    try {
      const hoje = frequencia.hojeLocal();
      if (estado.ultimaData === hoje) return;
      if (agoraHHMM() < hora()) return;
      await rodar({});
      // Mesmo sem ninguém para parabenizar, o dia se encerra: sem isto a
      // varredura recomeçaria a cada 5 min até a meia-noite.
      if (estado.ultimaData !== hoje) { estado.ultimaData = hoje; gravar(); }
    } catch (e) {
      log('falhou:', e.message);
    }
  };

  setTimeout(tentar, 120000).unref?.();
  setInterval(tentar, 5 * 60000).unref();
}

function situacao() {
  return {
    ativo: ativo(),
    hora: hora(),
    avisarGrupo: cfg().avisarGrupo !== false,
    semeadoEm: estado.semeadoEm,
    ultimaData: estado.ultimaData,
    matriculasAnotadas: Object.keys(estado.porMatricula).length,
    historico: historico.situacao(),
    marcos: marcosDoConfig().map((m) => ({
      aulas: m.aulas, titulo: m.titulo, emoji: m.emoji,
      temTexto: Boolean(String(m.mensagem || '').trim()),
    })),
  };
}

module.exports = { iniciar, rodar, situacao };
