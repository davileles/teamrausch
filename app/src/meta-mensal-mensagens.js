'use strict';

/**
 * app/src/meta-mensal-mensagens.js — davileles/teamrausch
 *
 * Manda o agradecimento quando o aluno Wellhub fecha a meta de check-ins do
 * mês: quem combinou 2x por semana recebe ao chegar em 8, quem combinou 3x
 * recebe ao chegar em 12.
 *
 * A META NÃO É CALCULADA AQUI
 *   O número vem de `alertas-frequencia.montarPainel`, o mesmo que abastece a
 *   aba Frequência e a cobrança. Conta própria acabaria divergindo, e o aluno
 *   receberia "obrigado pelos 8" enquanto a tela mostra 7/8. Por isso também
 *   já vem certo para conta compartilhada (cada um com a sua fatia da meta),
 *   para o teto de 12 do repasse e para experimental, que não tem meta.
 *
 * SÓ WELLHUB, SÓ CHECK-IN
 *   É o check-in que gera repasse, e é dele que o agradecimento fala.
 *   Mensalista não passa pelo portal; presença no totem é acompanhamento.
 *
 * UMA VEZ POR ALUNO POR MÊS
 *   Enviado fica anotado no mês. Check-in além da meta, ou grade trocada no
 *   meio do mês, não gera um segundo agradecimento.
 *
 * A PRIMEIRA EXECUÇÃO NÃO ENVIA NADA
 *   Subindo no meio do mês, quem já fechou a meta semanas atrás receberia um
 *   "obrigado" fora de hora. A primeira passada só anota quem já fechou; daí
 *   para frente, só quem fechar depois.
 *
 * O ÚLTIMO DIA DO MÊS NÃO SE PERDE
 *   A passada roda à noite. Check-in confirmado depois dela no dia 31 só
 *   apareceria no mês seguinte — então a passada do dia 1º também olha o
 *   fechamento do mês anterior.
 */

const fs = require('fs');
const path = require('path');

const config = require('./config');
const alertasFrequencia = require('./alertas-frequencia');
const frequencia = require('./frequencia');
const modelos = require('./mensagens-store');
const telefone = require('./telefone');
const poller = require('./poller-portal');
const grade = require('./grade');
const { enviarTexto, preencher } = require('./mensageiro');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ARQUIVO = path.join(DIR, 'meta-mensal-avisada.json');

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho',
  'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

const TEXTO_PADRAO = '🎯 *Meta do mês batida!*\n\n'
  + '{{nome}}, você completou os {{meta}} check-ins de {{mes}}. Muito obrigado! 🙏\n\n'
  + 'Cada check-in seu é importante para o desenvolvimento do estúdio e nos ajuda a '
  + 'atender você cada vez melhor.\n\n'
  + 'Bora manter esse ritmo! 💪';

function log(...a) { console.log(new Date().toISOString(), '[meta-mensal]', ...a); }

function dormir(ms) { return new Promise((r) => setTimeout(r, ms)); }

function cfg() {
  try { return config.ler().metaMensalAviso || {}; } catch (e) { return {}; }
}

function ativo() { return cfg().ativo !== false; }

function hora() { return String(cfg().hora || '20:45'); }

function modeloTexto() { return String(cfg().mensagem || '').trim() || TEXTO_PADRAO; }

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

let estado = { semeadoEm: null, ultimaData: null, porMes: {} };

(function carregar() {
  try {
    const bruto = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
    estado.semeadoEm = bruto.semeadoEm || null;
    estado.ultimaData = bruto.ultimaData || null;
    estado.porMes = bruto.porMes && typeof bruto.porMes === 'object' ? bruto.porMes : {};
  } catch (e) { /* primeira vez */ }
})();

function gravar() {
  try {
    // Três meses bastam para saber quem já recebeu; o resto é peso morto.
    const chaves = Object.keys(estado.porMes).sort();
    for (const velha of chaves.slice(0, Math.max(chaves.length - 3, 0))) delete estado.porMes[velha];
    fs.mkdirSync(DIR, { recursive: true });
    const temp = `${ARQUIVO}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(estado, null, 2));
    fs.renameSync(temp, ARQUIVO);
  } catch (e) { log('não consegui gravar o estado:', e.message); }
}

function jaAvisado(mes, matriculaId) {
  return Boolean((estado.porMes[mes] || {})[matriculaId]);
}

function anotar(mes, matriculaId, dados) {
  if (!estado.porMes[mes]) estado.porMes[mes] = {};
  estado.porMes[mes][matriculaId] = { ...dados, em: new Date().toISOString() };
}

/* -------------------------------- texto ---------------------------------- */

function primeiroNome(nome) {
  return String(nome || '').trim().split(/\s+/)[0] || '';
}

function nomeDoMes(data) {
  return MESES[Number(String(data).slice(5, 7)) - 1] || '';
}

function nomeDoEstudio() {
  try { return String((config.ler().estudio || {}).nome || '').trim(); } catch (e) { return ''; }
}

function montarTexto(a) {
  return preencher(modeloTexto(), {
    nome: primeiroNome(a.nome),
    nomeCompleto: a.nome || '',
    meta: a.mes.meta,
    realizado: a.mes.realizado,
    porSemana: a.mes.porSemanaCobravel,
    mes: nomeDoMes(a.mes.de),
    estudio: nomeDoEstudio(),
  });
}

/* ------------------------------ avaliação -------------------------------- */

/**
 * Datas a avaliar: hoje e, se ontem foi outro mês, o fechamento de ontem.
 */
function datasParaAvaliar(hoje) {
  const ontem = grade.somarDias(hoje, -1);
  return ontem.slice(0, 7) !== hoje.slice(0, 7) ? [ontem, hoje] : [hoje];
}

function quemFechou(ate) {
  const painel = alertasFrequencia.montarPainel({ ate, dias: 7 });
  return painel.alunos.filter((a) =>
    !a.experimental
    && a.mes && a.mes.meta > 0
    && a.mes.realizado >= a.mes.meta);
}

/* -------------------------------- envio ---------------------------------- */

async function avisarGrupo(saiu) {
  if (cfg().avisarGrupo === false || !saiu.length) return;
  const linhas = saiu.map((s) => `• ${s.nome} — ${s.realizado}/${s.meta} em ${s.mesNome}`);
  const corpo = [
    saiu.length === 1 ? '🎯 Meta do mês batida' : `🎯 Metas do mês batidas (${saiu.length})`,
    '',
    ...linhas,
    '',
    'O agradecimento já foi para o WhatsApp de cada um.',
  ];
  try {
    await poller.enviarWhatsApp(corpo.join('\n'));
  } catch (e) {
    // O aviso é registro, não o trabalho: as mensagens já saíram.
    log('não consegui avisar o grupo —', e.message);
  }
}

/**
 * Uma passada completa.
 *
 * @param {object} opcoes
 * @param {boolean} opcoes.avisar       `false` devolve o que sairia sem enviar nem anotar.
 * @param {boolean} opcoes.semearAgora  força a anotação inicial sem envio.
 */
async function rodar(opcoes = {}) {
  const simulacao = opcoes.avisar === false;
  const hoje = frequencia.hojeLocal();
  const semear = !estado.semeadoEm || opcoes.semearAgora === true;

  const pendentes = [];
  const vistos = new Set();
  for (const data of datasParaAvaliar(hoje)) {
    const mes = data.slice(0, 7);
    for (const a of quemFechou(data)) {
      const chave = `${mes}|${a.matriculaId}`;
      if (vistos.has(chave) || jaAvisado(mes, a.matriculaId)) continue;
      vistos.add(chave);
      pendentes.push({
        mes,
        mesNome: nomeDoMes(data),
        matriculaId: a.matriculaId,
        nome: a.nome,
        telefone: telefone.normalizar(a.telefone),
        meta: a.mes.meta,
        realizado: a.mes.realizado,
        texto: montarTexto(a),
      });
    }
  }

  if (semear && !simulacao) {
    for (const p of pendentes) anotar(p.mes, p.matriculaId, { meta: p.meta, semeado: true });
    estado.semeadoEm = new Date().toISOString();
    estado.ultimaData = hoje;
    gravar();
    log(`primeira passada: ${pendentes.length} aluno(s) que já tinham fechado a meta anotado(s), `
      + 'nenhuma mensagem enviada.');
    return { semeado: true, enviados: 0, anotados: pendentes.length, pendentes: [] };
  }

  if (simulacao) return { simulacao: true, seraSemeado: semear, enviados: 0, pendentes };

  let enviados = 0;
  const falhas = [];
  const saiu = [];
  for (const p of pendentes) {
    // Sem telefone não se anota: corrigido o cadastro, sai na passada seguinte
    // (desde que ainda seja o mesmo mês).
    if (!p.telefone) { falhas.push({ ...p, motivo: 'sem telefone' }); continue; }

    const r = await enviarTexto(p.telefone, p.texto);
    if (r.ok) {
      enviados++; saiu.push(p);
      anotar(p.mes, p.matriculaId, { meta: p.meta, realizado: p.realizado });
      gravar();
    } else {
      falhas.push({ ...p, motivo: r.motivo });
    }

    modelos.registrar({
      matriculaId: p.matriculaId, nome: p.nome, telefone: p.telefone, texto: p.texto,
      modeloId: null, modeloNome: `Meta do mês: ${p.realizado}/${p.meta}`, origem: 'meta-mensal',
      ok: r.ok, motivo: r.ok ? null : r.motivo,
    });

    await dormir(pausaMs());
  }

  estado.ultimaData = hoje;
  gravar();

  if (falhas.length) log(`${falhas.length} não saiu/saíram:`,
    falhas.map((f) => `${f.nome} (${f.motivo})`).join('; '));
  if (enviados) log(`${enviados} agradecimento(s) enviado(s).`);
  await avisarGrupo(saiu);

  return { enviados, falhas: falhas.length, pendentes, detalheFalhas: falhas };
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
      if (estado.ultimaData !== hoje) { estado.ultimaData = hoje; gravar(); }
    } catch (e) {
      log('falhou:', e.message);
    }
  };

  // Começa depois das conquistas (120s) para as duas passadas não disputarem
  // o WhatsApp no mesmo minuto após um deploy.
  setTimeout(tentar, 180000).unref?.();
  setInterval(tentar, 5 * 60000).unref();
}

function situacao() {
  const mesAtual = frequencia.hojeLocal().slice(0, 7);
  return {
    ativo: ativo(),
    hora: hora(),
    avisarGrupo: cfg().avisarGrupo !== false,
    semeadoEm: estado.semeadoEm,
    ultimaData: estado.ultimaData,
    avisadosNoMes: Object.keys(estado.porMes[mesAtual] || {}).length,
    textoPadrao: TEXTO_PADRAO,
  };
}

module.exports = { iniciar, rodar, situacao, TEXTO_PADRAO };
