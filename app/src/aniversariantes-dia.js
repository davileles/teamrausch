'use strict';

/**
 * app/src/aniversariantes-dia.js — davileles/teamrausch
 *
 * Avisa a operação, de manhã cedo, quem faz aniversário hoje.
 *
 * POR QUE ISTO NÃO É O MODELO "FELIZ ANIVERSÁRIO"
 *   Aquele modelo, no agendador de mensagens, parabeniza o ALUNO às 9h. Este
 *   aqui fala com a RECEPÇÃO às 5h30, antes de o estúdio abrir: quem chega
 *   para o primeiro horário já sabe quem parabenizar na porta. São públicos
 *   diferentes e horários diferentes, então são módulos diferentes.
 *
 * UMA VEZ POR DIA, DE VERDADE
 *   A marca do dia fica no volume, junto do resto do estado. Sem ela, cada
 *   deploy do Railway — que reinicia o processo — reenviaria o aviso, e três
 *   deploys numa manhã virariam três listas iguais no grupo.
 *
 * DIA VAZIO NÃO VIRA MENSAGEM
 *   Mesma regra do aviso de frequência: aviso que chega todo dia dizendo "não
 *   tem ninguém" deixa de ser lido, e aí o dia em que há aniversariante passa
 *   batido. Quem quiser o oposto liga ANIV_AVISO_SEM_NINGUEM=1.
 */

const fs = require('fs');
const path = require('path');

const destinatarios = require('./destinatarios');
const frequencia = require('./frequencia');
const grade = require('./grade');
const poller = require('./poller-portal');

const DATA_DIR = process.env.DATA_DIR || '/data';
const ARQ_ESTADO = path.join(DATA_DIR, 'aniversariantes-dia.json');

const ATIVO = String(process.env.ANIV_AVISO_ATIVO || 'true') === 'true';
const HORA = String(process.env.ANIV_AVISO_HORA || '05:30');
/** Dias da semana em que o aviso sai. 1=seg … 6=sáb, 0=dom. */
const DIAS_UTEIS = String(process.env.ANIV_AVISO_DIAS || '1,2,3,4,5')
  .split(',').map((x) => Number(x.trim())).filter((n) => n >= 0 && n <= 6);
/** Manda a lista mesmo quando ninguém faz aniversário. */
const SEM_NINGUEM = String(process.env.ANIV_AVISO_SEM_NINGUEM || '') === '1';
/** O aviso é operacional e sai antes do expediente: e-mail só se pedirem. */
const POR_EMAIL = String(process.env.ANIV_AVISO_EMAIL || '') === '1';

function log(...a) { console.log(new Date().toISOString(), '[aniversariantes]', ...a); }

let estado = { ultimoEnvioEm: null, ultimaData: null, ultimoTotal: null };

(function carregar() {
  try {
    const bruto = JSON.parse(fs.readFileSync(ARQ_ESTADO, 'utf8'));
    estado.ultimoEnvioEm = bruto.ultimoEnvioEm || null;
    estado.ultimaData = bruto.ultimaData || null;
    estado.ultimoTotal = bruto.ultimoTotal === undefined ? null : bruto.ultimoTotal;
  } catch (e) { /* primeira vez */ }
})();

function gravarEstado() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ARQ_ESTADO, JSON.stringify({
      ultimoEnvioEm: estado.ultimoEnvioEm,
      ultimaData: estado.ultimaData,
      ultimoTotal: estado.ultimoTotal,
    }, null, 2));
  } catch (e) { log('não consegui gravar o estado:', e.message); }
}

function agoraHHMM() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: process.env.TZ_ESTUDIO || 'America/Sao_Paulo',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
}

/* -------------------------------- lista ---------------------------------- */

/**
 * Aniversariantes de uma data. O filtro por 'MM-DD' já existe em
 * `destinatarios.montar`, que é o mesmo caminho usado pelo modelo automático —
 * duas leituras diferentes de "quem faz aniversário hoje" acabariam divergindo.
 *
 * @param {string} data 'YYYY-MM-DD'; padrão é hoje no fuso do estúdio.
 */
function listar(data) {
  const dia = data || frequencia.hojeLocal();
  const lista = destinatarios.montar('todos', { aniversarioEm: dia.slice(5) });
  return { data: dia, alunos: lista.alunos };
}

function rotuloDoPlano(vinculo) {
  if (vinculo === 'wellhub') return 'Wellhub';
  if (vinculo === 'mensalista') return 'Mensalista';
  return null;
}

/** Monta o texto que vai para o grupo. */
function montarTexto(painel) {
  const [, mes, dia] = String(painel.data).split('-');
  const cabecalho = `🎂 Aniversariantes de hoje — ${dia}/${mes}`;

  if (!painel.alunos.length) {
    return {
      assunto: cabecalho,
      texto: `${cabecalho}\n\nNinguém faz aniversário hoje.`,
    };
  }

  const linhas = painel.alunos
    .slice()
    .sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'))
    .map((a) => {
      const partes = [a.nome];
      const plano = rotuloDoPlano(a.vinculo);
      if (plano) partes.push(plano);
      // Telefone na lista para quem quiser mandar um áudio na hora, sem ter de
      // abrir o painel no meio do atendimento.
      partes.push(a.telefoneFormatado || 'sem telefone');
      return `• ${partes.join(' — ')}`;
    });

  const corpo = [cabecalho, '', ...linhas];

  const semTelefone = painel.alunos.filter((a) => !a.temTelefone).length;
  if (semTelefone) {
    corpo.push('', semTelefone === 1
      ? '⚠️ 1 aniversariante sem telefone: a mensagem automática das 9h não vai chegar nele.'
      : `⚠️ ${semTelefone} aniversariantes sem telefone: a mensagem automática das 9h não vai chegar neles.`);
  }

  return { assunto: cabecalho, texto: corpo.join('\n') };
}

/* -------------------------------- envio ---------------------------------- */

/**
 * Monta e dispara o aviso. `avisar: false` devolve o texto sem enviar — é o que
 * a pré-visualização do endpoint usa.
 */
async function rodar(opcoes = {}) {
  const painel = listar(opcoes.data);
  const { assunto, texto } = montarTexto(painel);

  const vaiEnviar = opcoes.avisar !== false
    && (painel.alunos.length > 0 || SEM_NINGUEM || opcoes.mesmoSemNinguem === true);

  if (vaiEnviar) {
    if (POR_EMAIL) await poller.enviarEmail(assunto, texto);
    await poller.enviarWhatsApp(texto);
    estado.ultimoEnvioEm = new Date().toISOString();
    estado.ultimaData = painel.data;
    estado.ultimoTotal = painel.alunos.length;
    gravarEstado();
    log(`aviso enviado: ${painel.alunos.length} aniversariante(s).`);
  }

  return {
    enviado: vaiEnviar,
    assunto,
    texto,
    data: painel.data,
    total: painel.alunos.length,
    alunos: painel.alunos.map((a) => ({
      matriculaId: a.matriculaId,
      nome: a.nome,
      vinculo: a.vinculo,
      telefone: a.telefoneFormatado,
      temTelefone: a.temTelefone,
    })),
  };
}

/* ------------------------------ agendador -------------------------------- */

/**
 * Checa a cada 5 min se chegou a hora. Comparar "passou de HORA e ainda não
 * enviei hoje" em vez de esperar o minuto exato é o que faz o aviso sair mesmo
 * quando o serviço estava reiniciando às 5:30 em ponto.
 */
function iniciar() {
  if (!ATIVO) { log('desligado (ANIV_AVISO_ATIVO=false).'); return; }
  log(`ligado: aviso diário às ${HORA}, dias ${DIAS_UTEIS.join(',')}.`);

  const tentar = async () => {
    try {
      const hoje = frequencia.hojeLocal();
      if (estado.ultimaData === hoje) return;
      if (!DIAS_UTEIS.includes(grade.diaDaSemana(hoje))) return;
      if (agoraHHMM() < HORA) return;

      const r = await rodar({});
      // Dia sem aniversariante também encerra o dia: sem isto, a checagem
      // tentaria de novo a cada 5 min até a meia-noite.
      if (!r.enviado) {
        estado.ultimaData = hoje;
        estado.ultimoTotal = 0;
        gravarEstado();
      }
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
    diasDaSemana: DIAS_UTEIS,
    mandaSemNinguem: SEM_NINGUEM,
    porEmail: POR_EMAIL,
    ultimoEnvioEm: estado.ultimoEnvioEm,
    ultimaData: estado.ultimaData,
    ultimoTotal: estado.ultimoTotal,
  };
}

module.exports = { iniciar, rodar, listar, montarTexto, situacao };
