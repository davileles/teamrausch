'use strict';

/**
 * app/src/relatorio-diario.js — davileles/teamrausch
 *
 * Todo dia de manhã, o fechamento do DIA ANTERIOR no grupo do operador:
 * quantos treinaram, quanto era esperado, se o mês está no ritmo, quanto o
 * mês já rendeu e quanto se está deixando na mesa.
 *
 * POR QUE ONTEM E NÃO HOJE
 *   O dia de hoje mal começou: às 6h o realizado é zero e o previsto é o dia
 *   inteiro, então todo relatório diria "estamos 100% atrás". Ontem é o único
 *   dia fechado — o portal já validou tudo o que tinha para validar e o número
 *   não muda mais depois que a mensagem sai.
 *
 * POR QUE NÃO REAPROVEITA O AVISO DE FREQUÊNCIA
 *   Aquele é uma lista de PESSOAS para cobrar, e só sai quando há devedor.
 *   Este é o placar do ESTÚDIO, e sai todo dia mesmo quando está tudo bem —
 *   é a série histórica que deixa perceber a queda antes do fechamento do mês.
 *
 * DE ONDE VÊM OS NÚMEROS
 *   `frequencia.panoramaDoMes`, o mesmo motor da aba Mês. Uma segunda conta
 *   aqui acabaria divergindo da tela, e aí ninguém saberia em qual acreditar.
 *
 * UMA VEZ POR DIA, DE VERDADE
 *   A marca do dia fica no volume. Sem ela, cada deploy do Railway — que
 *   reinicia o processo — reenviaria o mesmo relatório.
 */

const fs = require('fs');
const path = require('path');

const matriculas = require('./matriculas-store');
const checkins = require('./checkins-store');
const frequencia = require('./frequencia');
const grade = require('./grade');
const config = require('./config');
const poller = require('./poller-portal');

const DATA_DIR = process.env.DATA_DIR || '/data';
const ARQ_ESTADO = path.join(DATA_DIR, 'relatorio-diario.json');

const ATIVO = String(process.env.RELATORIO_ATIVO || 'true') === 'true';
const HORA = String(process.env.RELATORIO_HORA || '06:00');
/** Dias da semana em que o relatório sai. 1=seg … 6=sáb, 0=dom. */
const DIAS = String(process.env.RELATORIO_DIAS || '0,1,2,3,4,5,6')
  .split(',').map((x) => Number(x.trim())).filter((n) => n >= 0 && n <= 6);
/** O relatório é operacional e sai antes do expediente: e-mail só se pedirem. */
const POR_EMAIL = String(process.env.RELATORIO_EMAIL || '') === '1';

const NOME_DIA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

function log(...a) { console.log(new Date().toISOString(), '[relatorio]', ...a); }

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

function agoraHHMM() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: process.env.TZ_ESTUDIO || 'America/Sao_Paulo',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
}

/* -------------------------------- formato -------------------------------- */

function dinheiro(valor) {
  return 'R$ ' + Number(valor || 0).toLocaleString('pt-BR', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

function curta(data) {
  const [, mes, dia] = String(data).split('-');
  return `${dia}/${mes}`;
}

function plural(n, um, muitos) { return n === 1 ? um : muitos; }

/* -------------------------------- painel --------------------------------- */

/**
 * Monta o panorama do mês a que o dia pertence.
 *
 * O mês vem da DATA DO RELATÓRIO, não de hoje: no dia 1º o relatório é sobre
 * o dia 31 do mês passado, e puxar o panorama de setembro deixaria a linha do
 * dia de fora e os acumulados zerados.
 */
function montarPainel(data) {
  const de = frequencia.inicioDoMes(data);
  const ate = frequencia.fimDoMes(data);
  return frequencia.panoramaDoMes({
    matriculas: matriculas.listar(),
    excecoes: matriculas.excecoes({ de, ate }),
    checkins: checkins.listar({ de, ate, limite: 20000 }),
    mes: de.slice(0, 7),
    precos: config.ler().financeiro || {},
    produtos: checkins.produtoPorMatricula(),
  });
}

/**
 * Quem marcou Funcional, contado por PESSOA e por dia.
 *
 * `panoramaDoMes` devolve o funcional do mês inteiro, mas não quebrado por
 * dia — e a pergunta de todo relatório é "quantos foram ONTEM". A chave de
 * deduplicação é a mesma do repasse: uma pessoa por dia, com ficha ou sem.
 */
function funcionalDoDia(data) {
  const pessoas = new Set();
  for (const c of checkins.listar({ de: data, ate: data, limite: 5000 })) {
    if (frequencia.chaveProduto(c.produto) !== 'funcional') continue;
    pessoas.add(c.matriculaId ? `m:${c.matriculaId}` : `g:${c.gympassId || c.id}`);
  }
  return pessoas.size;
}

/* -------------------------------- texto ---------------------------------- */

function montarTexto(data, painel) {
  const linha = (painel.dias || []).find((d) => d.data === data);
  const fin = painel.financeiro || {};
  const troca = fin.trocaDeProduto || {};
  const funcionalOntem = funcionalDoDia(data);

  const cabecalho = `📊 Fechamento de ${curta(data)} (${NOME_DIA[grade.diaDaSemana(data)]})`;

  if (!linha) {
    return {
      assunto: cabecalho,
      texto: `${cabecalho}\n\nSem dados para este dia.`,
    };
  }

  const feitoDia = linha.feito + linha.fora + linha.ignorado
    + linha.experimental + linha.semVinculo;

  const corpo = [cabecalho, ''];

  /* ------------------------------ o dia ---------------------------------- */
  corpo.push('*CHECK-INS DE ONTEM*');
  corpo.push(`• Feitos: ${feitoDia}`);
  corpo.push(`• Esperado pela grade Wellhub: ${linha.previsto}`);
  const detalhe = [];
  if (linha.feito) detalhe.push(`${linha.feito} do pacote`);
  if (linha.fora) detalhe.push(`${linha.fora} ${plural(linha.fora, 'extra', 'extras')}`);
  if (linha.experimental) detalhe.push(`${linha.experimental} experimental`);
  if (linha.semVinculo) detalhe.push(`${linha.semVinculo} sem vínculo`);
  if (linha.ignorado) detalhe.push(`${linha.ignorado} acima do teto`);
  if (detalhe.length) corpo.push(`• Composição: ${detalhe.join(' · ')}`);
  corpo.push(`• Rendeu: ${dinheiro(linha.receita)}`);

  /* ----------------------------- o ritmo --------------------------------- */
  const esperadoMes = linha.metaAcum;
  const feitosMes = linha.feitoAcum;
  const saldo = feitosMes - esperadoMes;
  const marca = saldo < 0 ? '🔴' : '🟢';
  const veredito = saldo < 0
    ? `${marca} ${Math.abs(saldo)} atrás do ritmo`
    : saldo > 0
      ? `${marca} ${saldo} à frente do ritmo`
      : `${marca} exatamente no ritmo`;

  corpo.push('');
  corpo.push(`*RITMO DO MÊS* (até ${curta(data)})`);
  corpo.push(`• Era para ter: ${esperadoMes} check-ins do pacote`);
  corpo.push(`• Foram feitos: ${feitosMes}`);
  corpo.push(`• ${veredito}`);
  corpo.push(`• Meta cheia do mês: ${painel.metaMes} · extras já pagos: ${linha.foraAcum}`);

  /* -------------------------- experimentais ------------------------------ */
  corpo.push('');
  corpo.push('*EXPERIMENTAIS*');
  corpo.push(`• Ontem: ${linha.experimental}`);
  corpo.push(`• No mês: ${linha.experimentalAcum}`);

  /* ----------------------------- funcional ------------------------------- */
  const porProduto = fin.porProduto || {};
  const funcionalMes = (porProduto.funcional || {}).checkins || 0;
  const crossMes = (porProduto.crosstraining || {}).checkins || 0;

  corpo.push('');
  corpo.push('*FUNCIONAL EM VEZ DE CROSSTRAINING*');
  corpo.push(`• Ontem: ${funcionalOntem} ${plural(funcionalOntem, 'aluno', 'alunos')}`);
  corpo.push(`• No mês: ${funcionalMes} ${plural(funcionalMes, 'check-in', 'check-ins')}`
    + ` (contra ${crossMes} no crosstraining)`);
  if (troca.pessoas) {
    corpo.push(`• ${troca.pessoas} ${plural(troca.pessoas, 'pessoa', 'pessoas')}`
      + ` ${plural(troca.pessoas, 'marca', 'marcam')} o produto mais barato`);
  }
  corpo.push(`• Deixado na mesa no mês: ${dinheiro(troca.deixadoNaMesa)}`);
  if (fin.mesCorrente && troca.aRecuperar) {
    corpo.push(`• Ainda dá para recuperar: ${dinheiro(troca.aRecuperar)}`);
  }

  /* ------------------------------ dinheiro ------------------------------- */
  const realizado = fin.realizado || {};
  corpo.push('');
  corpo.push('*RENDA DO MÊS*');
  corpo.push(`• Acumulado até agora: ${dinheiro(realizado.total)}`);
  corpo.push(`• Check-ins pagos: ${(fin.checkins || {}).pagos || 0}`);
  if (fin.perdido) {
    corpo.push(`• Perdido acima do teto de 12: ${dinheiro(fin.perdido)}`
      + ` (${(fin.checkins || {}).naoPagos || 0} check-ins)`);
  }
  const perdaTotal = Number(fin.perdido || 0) + Number(troca.deixadoNaMesa || 0);
  corpo.push(`• Perda total do mês: ${dinheiro(perdaTotal)}`
    + ' (teto + produto barato)');
  if (fin.mesCorrente) {
    corpo.push(`• Ainda a receber: ${dinheiro(fin.aReceber)}`
      + ` em ${fin.diasRestantes} ${plural(fin.diasRestantes, 'dia', 'dias')}`);
    corpo.push(`• Previsto para o mês: ${dinheiro(fin.previsto)}`);
  }

  /* ------------------------------ pendência ------------------------------ */
  if (linha.semVinculoAcum) {
    corpo.push('');
    corpo.push(`⚠️ ${linha.semVinculoAcum} check-in(s) do mês sem aluno identificado — `
      + 'vincule em Matrículas → Frequência para que contem.');
  }

  return { assunto: `${cabecalho} — ${feitoDia} check-ins`, texto: corpo.join('\n') };
}

/* -------------------------------- envio ---------------------------------- */

/**
 * Monta e dispara o relatório. `avisar: false` devolve o texto sem enviar — é
 * o que a pré-visualização do endpoint usa.
 *
 * @param {object} opcoes
 *   data     'YYYY-MM-DD' do dia a relatar; padrão é ontem.
 *   avisar   false só monta o texto.
 */
async function rodar(opcoes = {}) {
  const data = opcoes.data || grade.somarDias(frequencia.hojeLocal(), -1);
  const painel = montarPainel(data);
  const { assunto, texto } = montarTexto(data, painel);

  const vaiEnviar = opcoes.avisar !== false;
  if (vaiEnviar) {
    if (POR_EMAIL) await poller.enviarEmail(assunto, texto);
    await poller.enviarWhatsApp(texto);
    estado.ultimoEnvioEm = new Date().toISOString();
    estado.ultimaData = data;
    gravarEstado();
    log(`relatório de ${data} enviado.`);
  }

  estado.ultimoResumo = {
    em: new Date().toISOString(),
    data,
    receitaMes: (painel.financeiro || {}).realizado
      ? painel.financeiro.realizado.total : null,
  };

  return { enviado: vaiEnviar, data, assunto, texto, painel: painel.totais, financeiro: painel.financeiro };
}

/* ------------------------------ agendador -------------------------------- */

/**
 * Checa a cada 5 min se chegou a hora. Comparar "passou de HORA e ainda não
 * enviei o relatório de ontem" em vez de esperar o minuto exato é o que faz o
 * relatório sair mesmo quando o serviço estava reiniciando às 6:00 em ponto.
 */
function iniciar() {
  if (!ATIVO) { log('desligado (RELATORIO_ATIVO=false).'); return; }
  log(`ligado: relatório diário às ${HORA}, dias ${DIAS.join(',')}.`);

  const tentar = async () => {
    try {
      const hoje = frequencia.hojeLocal();
      const ontem = grade.somarDias(hoje, -1);
      if (estado.ultimaData === ontem) return;
      if (!DIAS.includes(grade.diaDaSemana(hoje))) return;
      if (agoraHHMM() < HORA) return;
      await rodar({ data: ontem });
    } catch (e) {
      log('falhou:', e.message);
    }
  };

  setTimeout(tentar, 120000).unref?.();
  setInterval(tentar, 5 * 60000).unref();
}

function situacao() {
  return {
    ativo: ATIVO,
    hora: HORA,
    diasDaSemana: DIAS,
    porEmail: POR_EMAIL,
    ultimoEnvioEm: estado.ultimoEnvioEm,
    ultimaData: estado.ultimaData,
    ultimoResumo: estado.ultimoResumo,
  };
}

module.exports = { iniciar, rodar, montarPainel, montarTexto, situacao };
