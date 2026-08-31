'use strict';

/**
 * app/src/agendador-mensagens.js — davileles/teamrausch
 *
 * Dispara sozinho os modelos em modo `programado` (uma data e hora) e
 * `recorrente` (aniversário, dia do mês, dia da semana).
 *
 * POR QUE ISTO NÃO PODE MORAR NO NAVEGADOR
 *   O disparo em massa manual roda na tela porque você está lá olhando. Um
 *   modelo marcado para as 9h do aniversário do aluno precisa de alguém
 *   acordado às 9h — e a aba fechada não está. Por isso o agendado vive aqui,
 *   no mesmo desenho do aviso diário de frequência.
 *
 * UMA VEZ POR CICLO, DE VERDADE
 *   A marca do último disparo fica no volume, junto do modelo. Sem ela, cada
 *   deploy do Railway — que reinicia o processo — reenviaria o mesmo lote, e
 *   três deploys numa manhã virariam três mensagens iguais para a base toda.
 *
 * ATRASO TEM LIMITE
 *   Se o serviço passou o fim de semana fora do ar, um modelo marcado para
 *   sexta não deve sair na segunda: a mensagem já não faz sentido e ninguém
 *   pediu por ela. Passada a tolerância, o modelo é marcado como vencido sem
 *   enviar nada.
 */

const modelos = require('./mensagens-store');
const destinatarios = require('./destinatarios');
const frequencia = require('./frequencia');
const grade = require('./grade');
const { enviarTexto } = require('./mensageiro');
const telefone = require('./telefone');

const ATIVO = String(process.env.MSG_AGENDADOR_ATIVO || 'true') === 'true';
/** Pausa entre um aluno e o próximo. O serviço de WhatsApp já tem fila
 *  interna, mas ela é de 1,2 s — curta demais para um lote de 80 pessoas. */
const PAUSA_MS = Number(process.env.MSG_PAUSA_MS || 8000);
/** Quanto tempo depois da hora marcada ainda vale enviar. */
const TOLERANCIA_MIN = Number(process.env.MSG_TOLERANCIA_MIN || 720);

function log(...a) { console.log(new Date().toISOString(), '[msg-agendador]', ...a); }

function dormir(ms) { return new Promise((r) => setTimeout(r, ms)); }

function agoraHHMM() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: process.env.TZ_ESTUDIO || 'America/Sao_Paulo',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
}

function emMinutos(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return (h * 60) + m;
}

/* ------------------------------- decisão --------------------------------- */

/**
 * Decide se um modelo deve disparar agora.
 * @returns {{ disparar: boolean, marca: string|null, vencido?: boolean }}
 */
function avaliar(modelo, hoje, hhmm) {
  if (!modelo.ativo) return { disparar: false, marca: null };
  const agora = emMinutos(hhmm);

  if (modelo.modo === 'programado') {
    const [dia, hora] = String(modelo.quando || '').split('T');
    if (!dia || !hora) return { disparar: false, marca: null };
    if (modelo.ultimaMarca) return { disparar: false, marca: null };
    if (dia > hoje) return { disparar: false, marca: null };

    // Atraso em minutos: dias inteiros já passados contam integralmente.
    const atraso = dia === hoje
      ? agora - emMinutos(hora)
      : TOLERANCIA_MIN + 1;
    if (atraso < 0) return { disparar: false, marca: null };
    if (atraso > TOLERANCIA_MIN) return { disparar: false, marca: hoje, vencido: true };
    return { disparar: true, marca: hoje };
  }

  if (modelo.modo !== 'recorrente') return { disparar: false, marca: null };
  if (modelo.ultimaMarca === hoje) return { disparar: false, marca: null };
  if (agora < emMinutos(modelo.hora || '09:00')) return { disparar: false, marca: null };

  if (modelo.gatilho === 'dia_do_mes') {
    if (Number(hoje.slice(8, 10)) !== Number(modelo.diaDoMes)) return { disparar: false, marca: null };
    return { disparar: true, marca: hoje };
  }
  if (modelo.gatilho === 'dia_da_semana') {
    if (grade.diaDaSemana(hoje) !== Number(modelo.diaDaSemana)) return { disparar: false, marca: null };
    return { disparar: true, marca: hoje };
  }
  if (modelo.gatilho === 'aniversario') {
    // Roda todo dia; quem filtra é a lista de destinatários. Se ninguém faz
    // aniversário hoje, o lote sai vazio e a marca do dia é gravada mesmo
    // assim, para não recalcular a cada 5 minutos.
    return { disparar: true, marca: hoje };
  }
  return { disparar: false, marca: null };
}

/* -------------------------------- envio ---------------------------------- */

async function disparar(modelo, hoje) {
  const opcoes = modelo.gatilho === 'aniversario' ? { aniversarioEm: hoje.slice(5) } : {};
  const lista = destinatarios.montar(modelo.publico, opcoes);
  const alvos = lista.alunos.filter((a) => a.temTelefone);

  if (!alvos.length) {
    log(`"${modelo.nome}": ninguém para receber hoje.`);
    return { enviados: 0, falhas: 0, total: 0 };
  }

  const lote = 'LOTE-' + Date.now().toString(36);
  log(`"${modelo.nome}": ${alvos.length} destinatário(s), lote ${lote}.`);

  let enviados = 0;
  let falhas = 0;
  for (const a of alvos) {
    const texto = destinatarios.preencher(modelo.texto, a);
    const numero = telefone.normalizar(a.telefone);
    const r = await enviarTexto(numero, texto);
    if (r.ok) enviados++; else falhas++;

    modelos.registrar({
      matriculaId: a.matriculaId, nome: a.nome, telefone: numero, texto,
      modeloId: modelo.id, modeloNome: modelo.nome, origem: 'agendado',
      lote, ok: r.ok, motivo: r.ok ? null : r.motivo,
    });

    await dormir(PAUSA_MS);
  }

  log(`"${modelo.nome}": ${enviados} enviada(s), ${falhas} com erro.`);
  return { enviados, falhas, total: alvos.length, lote };
}

/* ------------------------------- ciclo ----------------------------------- */

let rodando = false;

/** Uma passada por todos os modelos. Exposta para o endpoint de teste. */
async function rodar({ forcarId = null } = {}) {
  if (rodando) return { pulado: 'ciclo anterior ainda rodando' };
  rodando = true;
  const hoje = frequencia.hojeLocal();
  const hhmm = agoraHHMM();
  const feitos = [];

  try {
    for (const m of modelos.listarModelos()) {
      if (forcarId && m.id !== forcarId) continue;

      const d = forcarId === m.id
        ? { disparar: true, marca: hoje }
        : avaliar(m, hoje, hhmm);

      if (d.vencido) {
        log(`"${m.nome}": passou da tolerância de ${TOLERANCIA_MIN} min — não enviei.`);
        modelos.marcarDisparo(m.id, d.marca);
        feitos.push({ modelo: m.nome, vencido: true });
        continue;
      }
      if (!d.disparar) continue;

      // A marca vai ANTES do envio: um lote de 80 alunos leva minutos, e um
      // reinício no meio não pode fazer o ciclo começar do zero.
      modelos.marcarDisparo(m.id, d.marca);
      const r = await disparar(m, hoje);
      feitos.push({ modelo: m.nome, ...r });
    }
  } catch (e) {
    log('falhou:', e.message);
  } finally {
    rodando = false;
  }

  return { em: new Date().toISOString(), hoje, hora: hhmm, feitos };
}

function iniciar() {
  if (!ATIVO) { log('desligado (MSG_AGENDADOR_ATIVO=false).'); return; }
  log(`ligado: checagem a cada 5 min, pausa de ${PAUSA_MS / 1000}s entre envios.`);
  setTimeout(() => rodar().catch((e) => log(e.message)), 90000).unref?.();
  setInterval(() => rodar().catch((e) => log(e.message)), 5 * 60000).unref();
}

function situacao() {
  return {
    ativo: ATIVO,
    pausaMs: PAUSA_MS,
    toleranciaMin: TOLERANCIA_MIN,
    rodando,
    agendados: modelos.listarModelos()
      .filter((m) => m.modo !== 'manual' && m.ativo)
      .map((m) => ({
        id: m.id, nome: m.nome, modo: m.modo, gatilho: m.gatilho,
        quando: m.quando, hora: m.hora, publico: m.publico,
        ultimoDisparoEm: m.ultimoDisparoEm,
      })),
  };
}

module.exports = { iniciar, rodar, situacao, avaliar };
