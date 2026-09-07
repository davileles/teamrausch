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
const poller = require('./poller-portal');
const config = require('./config');

/**
 * Vem de Configurações → Frequência, lido na hora de usar e não no boot: a
 * tela edita, e uma constante congelada faria o botão salvar sem efeito até o
 * próximo deploy.
 */
function cfg() {
  try {
    return config.ler().mensagens || {};
  } catch (e) {
    return {};
  }
}

function ativo() { return cfg().agendadorAtivo !== false; }

/** Pausa entre um aluno e o próximo. O serviço de WhatsApp já tem fila
 *  interna, mas ela é de 1,2 s — curta demais para um lote de 80 pessoas. */
function pausaMs() {
  const s = Number(cfg().pausaSegundos);
  return Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : 8000;
}

/** Quanto tempo depois da hora marcada ainda vale enviar. */
function toleranciaMin() {
  const n = Number(cfg().toleranciaMin);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 720;
}

/** Até quantos nomes cabem no aviso do grupo antes de virar parede de texto. */
function avisoMaxLinhas() {
  const n = Number(cfg().avisoMaxLinhas);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 25;
}

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
  const TOLERANCIA_MIN = toleranciaMin();

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

  if (modelo.gatilho === 'diario') {
    // Todo dia depois da hora marcada. Só faz sentido junto de um público
    // calculado e de um intervalo por aluno — sem o intervalo, isto vira a
    // mesma mensagem todos os dias para quem continuar no público.
    return { disparar: true, marca: hoje };
  }
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

/**
 * Conta ao grupo do estúdio o que acabou de sair sozinho.
 *
 * POR QUE DEPOIS, E NÃO ANTES
 *   Aviso prévio não dá para cancelar nada: o agendador não espera resposta.
 *   Depois, o texto pode dizer o que de fato aconteceu — quem recebeu, quem
 *   falhou e quem ficou de fora pelo intervalo. É esse o registro que serve
 *   quando o aluno responde no grupo e ninguém sabe do que ele está falando.
 *
 *   Vai só para o WhatsApp das listas do estúdio, não para o e-mail: é rotina
 *   diária, e o e-mail está reservado para o que precisa de atenção.
 */
async function avisarGrupo(modelo, resultado, pulados) {
  if (modelo.avisarGrupo === false) return;
  const { alvos = [], falhas = [] } = resultado;
  if (!alvos.length && !pulados) return;

  const teto = avisoMaxLinhas();
  const linhas = alvos.slice(0, teto).map((a) => {
    const quanto = a.diasSemTreinar === null || a.diasSemTreinar === undefined
      ? 'nunca treinou'
      : `${a.diasSemTreinar} dias sem treinar`;
    const tel = a.telefoneFormatado || a.telefone || 'sem telefone';
    return `• ${a.nome} — ${quanto} · ${tel}`;
  });
  if (alvos.length > teto) {
    linhas.push(`…e mais ${alvos.length - teto}.`);
  }

  const corpo = [`📤 Enviei "${modelo.nome}" para ${alvos.length} aluno(s).`, ''];
  if (linhas.length) corpo.push(...linhas, '');
  if (falhas.length) {
    corpo.push(`⚠️ ${falhas.length} não saiu/saíram: `
      + falhas.slice(0, 5).map((f) => f.nome).join(', ') + '.', '');
  }
  if (pulados) {
    corpo.push(`${pulados} não entrou/entraram: já receberam esta mensagem nos `
      + `últimos ${modelo.intervaloDias} dias.`, '');
  }
  corpo.push('Se alguém aqui já saiu do estúdio, inative a ficha em Matrículas '
    + 'para não receber de novo.');

  try {
    await poller.enviarWhatsApp(corpo.join('\n'));
    log(`"${modelo.nome}": grupo avisado.`);
  } catch (e) {
    // O aviso é registro, não o trabalho. Se ele falhar, as mensagens já
    // saíram e o histórico continua tendo tudo.
    log(`"${modelo.nome}": não consegui avisar o grupo — ${e.message}`);
  }
}

async function disparar(modelo, hoje) {
  const opcoes = modelo.gatilho === 'aniversario' ? { aniversarioEm: hoje.slice(5) } : {};
  if (modelo.ausenteDias) opcoes.ausenteDias = modelo.ausenteDias;
  if (modelo.ausenteAte) opcoes.ausenteAte = modelo.ausenteAte;
  const lista = destinatarios.montar(modelo.publico, opcoes);
  let alvos = lista.alunos.filter((a) => a.temTelefone);

  // INTERVALO POR ALUNO
  //   O público de "sumidos" não muda de um dia para o outro: quem sumiu há
  //   40 dias continua sumido amanhã. Sem esta trava, um modelo diário manda
  //   a mesma cobrança todo dia para a mesma pessoa — que é o caminho curto
  //   para o aluno bloquear o estúdio e o número cair.
  //
  //   Conta envios de qualquer origem, inclusive os feitos à mão pela tela:
  //   se você acabou de falar com a pessoa, o automático não repete atrás.
  const recentes = modelos.recebeuDoModeloDesde(modelo.id, modelo.intervaloDias);
  let pulados = 0;
  if (recentes.size) {
    const antes = alvos.length;
    alvos = alvos.filter((a) => !recentes.has(a.matriculaId));
    pulados = antes - alvos.length;
    if (pulados) log(`"${modelo.nome}": ${pulados} pulado(s) — já receberam nos `
      + `últimos ${modelo.intervaloDias} dias.`);
  }

  if (!alvos.length) {
    log(`"${modelo.nome}": ninguém para receber hoje.`);
    return { enviados: 0, falhas: 0, total: 0, pulados };
  }

  const lote = 'LOTE-' + Date.now().toString(36);
  log(`"${modelo.nome}": ${alvos.length} destinatário(s), lote ${lote}.`);

  let enviados = 0;
  const falhas = [];
  const saiu = [];
  for (const a of alvos) {
    const texto = destinatarios.preencher(modelo.texto, a);
    const numero = telefone.normalizar(a.telefone);
    const r = await enviarTexto(numero, texto);
    if (r.ok) { enviados++; saiu.push(a); } else { falhas.push({ ...a, motivo: r.motivo }); }

    modelos.registrar({
      matriculaId: a.matriculaId, nome: a.nome, telefone: numero, texto,
      modeloId: modelo.id, modeloNome: modelo.nome, origem: 'agendado',
      lote, ok: r.ok, motivo: r.ok ? null : r.motivo,
    });

    await dormir(pausaMs());
  }

  log(`"${modelo.nome}": ${enviados} enviada(s), ${falhas.length} com erro.`);
  await avisarGrupo(modelo, { alvos: saiu, falhas }, pulados);
  return { enviados, falhas: falhas.length, total: alvos.length, pulados, lote };
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
        log(`"${m.nome}": passou da tolerância de ${toleranciaMin()} min — não enviei.`);
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
  // O timer sempre sobe: ligar e desligar virou decisão de tela, e um `return`
  // aqui deixaria o agendador morto até o próximo deploy.
  log(`agendado: checagem a cada 5 min, pausa de ${pausaMs() / 1000}s entre envios`
    + `${ativo() ? '' : ' — DESLIGADO na configuração'}.`);
  const ciclo = () => {
    if (!ativo()) return;
    rodar().catch((e) => log(e.message));
  };
  setTimeout(ciclo, 90000).unref?.();
  setInterval(ciclo, 5 * 60000).unref();
}

function situacao() {
  return {
    ativo: ativo(),
    pausaMs: pausaMs(),
    toleranciaMin: toleranciaMin(),
    avisoMaxLinhas: avisoMaxLinhas(),
    rodando,
    agendados: modelos.listarModelos()
      .filter((m) => m.modo !== 'manual' && m.ativo)
      .map((m) => ({
        id: m.id, nome: m.nome, modo: m.modo, gatilho: m.gatilho,
        quando: m.quando, hora: m.hora, publico: m.publico,
        intervaloDias: m.intervaloDias || 0, ausenteDias: m.ausenteDias || 0,
        ausenteAte: m.ausenteAte || 0, avisarGrupo: m.avisarGrupo !== false,
        ultimoDisparoEm: m.ultimoDisparoEm,
      })),
  };
}

module.exports = { iniciar, rodar, situacao, avaliar };
