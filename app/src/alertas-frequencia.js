'use strict';

/**
 * app/src/alertas-frequencia.js — davileles/teamrausch
 *
 * Uma vez por dia, no horário configurado, monta a lista de quem está atrasado
 * na frequência combinada e manda para as listas de aviso do estúdio.
 *
 * O AVISO VAI PARA VOCÊ, NÃO PARA O ALUNO
 *   Disparar cobrança automática no WhatsApp do aluno erra feio quando o motivo
 *   da falta é conhecido (lesão, viagem, luto) e o sistema não sabe. O aviso
 *   diário é uma lista para você olhar; a cobrança sai por decisão sua, com um
 *   toque, pela tela de Frequência.
 *
 * UMA VEZ POR DIA, DE VERDADE
 *   O marcador do último envio fica no volume. Sem isso, cada deploy do Railway
 *   — que reinicia o processo — reenviaria a mesma lista, e três deploys numa
 *   manhã virariam três avisos idênticos.
 */

const fs = require('fs');
const path = require('path');
const matriculas = require('./matriculas-store');
const checkins = require('./checkins-store');
const frequencia = require('./frequencia');
const poller = require('./poller-portal');
const { enviarTexto } = require('./mensageiro');
const grade = require('./grade');

const DATA_DIR = process.env.DATA_DIR || '/data';
const ARQ_ESTADO = path.join(DATA_DIR, 'alertas-frequencia.json');

const ATIVO = String(process.env.FREQ_ALERTA_ATIVO || 'true') === 'true';
const HORA = String(process.env.FREQ_ALERTA_HORA || '10:00');
const JANELA_DIAS = Number(process.env.FREQ_JANELA_DIAS || 7);
/** Dias da semana em que o aviso sai. 1=seg … 6=sáb, 0=dom. */
const DIAS_UTEIS = String(process.env.FREQ_ALERTA_DIAS || '1,2,3,4,5')
  .split(',').map((x) => Number(x.trim())).filter((n) => n >= 0 && n <= 6);

function log(...a) { console.log(new Date().toISOString(), '[freq-alerta]', ...a); }

let estado = { ultimoEnvioEm: null, ultimaData: null, ultimoResumo: null };

(function carregar() {
  try {
    const bruto = JSON.parse(fs.readFileSync(ARQ_ESTADO, 'utf8'));
    estado.ultimoEnvioEm = bruto.ultimoEnvioEm || null;
    estado.ultimaData = bruto.ultimaData || null;
  } catch (e) { /* primeira vez */ }
})();

function gravarEstado() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ARQ_ESTADO, JSON.stringify({
      ultimoEnvioEm: estado.ultimoEnvioEm,
      ultimaData: estado.ultimaData,
    }, null, 2));
  } catch (e) { log('não consegui gravar o estado:', e.message); }
}

/* ------------------------------- painel ---------------------------------- */

/** Monta o panorama de frequência com os dados que estão valendo agora. */
function montarPainel(opcoes = {}) {
  const dias = Number(opcoes.dias) > 0 ? Number(opcoes.dias) : JANELA_DIAS;
  const ate = opcoes.ate || frequencia.hojeLocal();
  const de = grade.somarDias(ate, -(dias - 1));

  return frequencia.painel(
    matriculas.listar(),
    checkins.mapaPorMatricula(),           // histórico inteiro: alimenta o "sem treinar há N dias"
    matriculas.excecoes({ de, ate }),
    { dias, ate, vinculo: opcoes.vinculo === undefined ? 'wellhub' : opcoes.vinculo },
  );
}

/* -------------------------------- texto ---------------------------------- */

function linha(a) {
  const marca = a.situacao === 'critico' ? '🔴' : '🟡';
  const falta = Math.abs(a.saldo);
  const desde = a.ultimoCheckin
    ? `último em ${a.ultimoCheckin.split('-').reverse().slice(0, 2).join('/')}`
    : 'nenhum check-in registrado';
  return `${marca} ${a.nome} — ${a.realizado}/${a.esperado} `
    + `(falta${falta === 1 ? '' : 'm'} ${falta}) · ${desde}`;
}

function montarTexto(painel) {
  const devedores = frequencia.devedores(painel);
  const { de, ate, dias } = painel.janela;
  const periodo = `${de.split('-').reverse().join('/')} a ${ate.split('-').reverse().join('/')}`;

  if (!devedores.length) {
    return {
      assunto: '✅ Frequência em dia',
      texto: `Todos os ${painel.resumo.avaliados} alunos Wellhub estão em dia com a `
        + `frequência combinada nos últimos ${dias} dias (${periodo}).`,
    };
  }

  const corpo = [];
  corpo.push(`Frequência dos últimos ${dias} dias (${periodo}):`);
  corpo.push('');
  corpo.push(devedores.map(linha).join('\n'));
  corpo.push('');
  corpo.push(`${painel.resumo.emDia} em dia · ${painel.resumo.atrasados} atrasados · `
    + `${painel.resumo.criticos} críticos.`);

  const semVinculo = checkins.resumo().semVinculo7;
  if (semVinculo) {
    corpo.push('');
    corpo.push(`⚠️ ${semVinculo} check-in(s) da semana sem aluno identificado — `
      + 'vincule na aba Matrículas → Frequência para que contem.');
  }

  return {
    assunto: `🟡 Frequência: ${devedores.length} aluno(s) atrasado(s)`,
    texto: corpo.join('\n'),
  };
}

/* -------------------------------- envio ---------------------------------- */

/**
 * Monta e dispara o aviso. `avisar: false` devolve o texto sem enviar — é o que
 * o endpoint de pré-visualização usa.
 */
async function rodar(opcoes = {}) {
  const painel = montarPainel(opcoes);
  const { assunto, texto } = montarTexto(painel);
  const devedores = frequencia.devedores(painel);

  // Dia sem devedor não vira mensagem: aviso que chega todo dia dizendo "está
  // tudo bem" deixa de ser lido, e aí o dia em que há problema passa batido.
  const vaiEnviar = opcoes.avisar !== false
    && (devedores.length > 0 || opcoes.mesmoSemDevedores === true);

  if (vaiEnviar) {
    await poller.avisar(assunto, texto);
    estado.ultimoEnvioEm = new Date().toISOString();
    estado.ultimaData = painel.janela.ate;
    gravarEstado();
    log(`aviso enviado: ${devedores.length} devedor(es).`);
  }

  estado.ultimoResumo = { em: new Date().toISOString(), ...painel.resumo };
  return { enviado: vaiEnviar, assunto, texto, resumo: painel.resumo, devedores };
}

/* ------------------------------ cobrança --------------------------------- */

const MODELO_COBRANCA = process.env.FREQ_TEXTO_COBRANCA
  || 'Oi, {{nome}}! Aqui é do TeamRausch. Pelos nossos registros você fez '
   + '{{realizado}} de {{esperado}} treinos combinados nos últimos {{dias}} dias. '
   + 'Consegue repor essa semana? Se precisar remarcar horário, é só falar com a gente.';

/** Cobra um aluno específico, com o texto padrão ou um escrito na hora. */
async function cobrar(matriculaId, textoLivre) {
  const m = matriculas.porId(matriculaId);
  if (!m) return { ok: false, motivo: 'Matrícula não encontrada.' };
  if (!m.telefone) return { ok: false, motivo: `${m.nome} não tem telefone cadastrado.` };

  const dias = JANELA_DIAS;
  const ate = frequencia.hojeLocal();
  const de = grade.somarDias(ate, -(dias - 1));
  const situacao = frequencia.avaliar(
    m, checkins.datasDaMatricula(m.id), matriculas.excecoes({ de, ate, matriculaId: m.id }),
    { dias, ate });

  const texto = String(textoLivre || MODELO_COBRANCA)
    .replace(/\{\{nome\}\}/g, String(m.nome).split(' ')[0])
    .replace(/\{\{realizado\}\}/g, situacao.realizado)
    .replace(/\{\{esperado\}\}/g, situacao.esperado)
    .replace(/\{\{dias\}\}/g, dias);

  const r = await enviarTexto(m.telefone, texto);
  if (!r.ok) return { ok: false, motivo: r.motivo, texto };
  log(`cobrança enviada para ${m.nome}.`);
  return { ok: true, texto, telefone: m.telefone, situacao };
}

/* ------------------------------ agendador -------------------------------- */

function agoraHHMM() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: process.env.TZ_ESTUDIO || 'America/Sao_Paulo',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
}

/**
 * Checa a cada 5 min se chegou a hora. Comparar "passou de HORA e ainda não
 * enviei hoje" em vez de esperar o minuto exato é o que faz o aviso sair mesmo
 * quando o serviço estava reiniciando às 10:00 em ponto.
 */
function iniciar() {
  if (!ATIVO) { log('desligado (FREQ_ALERTA_ATIVO=false).'); return; }
  log(`ligado: aviso diário às ${HORA}, janela de ${JANELA_DIAS} dias, `
    + `dias ${DIAS_UTEIS.join(',')}.`);

  const tentar = async () => {
    try {
      const hoje = frequencia.hojeLocal();
      if (estado.ultimaData === hoje) return;
      if (!DIAS_UTEIS.includes(grade.diaDaSemana(hoje))) return;
      if (agoraHHMM() < HORA) return;

      const r = await rodar({});
      // Nada a avisar hoje também encerra o dia: sem isto, a checagem tentaria
      // de novo a cada 5 min até a meia-noite.
      if (!r.enviado) { estado.ultimaData = hoje; gravarEstado(); }
    } catch (e) {
      log('falhou:', e.message);
    }
  };

  setTimeout(tentar, 60000).unref?.();
  setInterval(tentar, 5 * 60000).unref();
}

function situacao() {
  return {
    ativo: ATIVO,
    hora: HORA,
    janelaDias: JANELA_DIAS,
    diasDaSemana: DIAS_UTEIS,
    ultimoEnvioEm: estado.ultimoEnvioEm,
    ultimaData: estado.ultimaData,
    ultimoResumo: estado.ultimoResumo,
  };
}

module.exports = { iniciar, rodar, cobrar, montarPainel, situacao, JANELA_DIAS };
