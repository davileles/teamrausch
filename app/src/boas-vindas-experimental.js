'use strict';

/**
 * app/src/boas-vindas-experimental.js — davileles/teamrausch
 *
 * Agradece a aula experimental no WhatsApp e convida o aluno a voltar.
 *
 * QUEM RECEBE
 *   Matrícula ativa, marcada como experimental, com telefone e com pelo menos
 *   uma aula contada (check-in Wellhub ou presença no tablet). A aula precisa
 *   estar registrada porque o texto agradece a presença — cadastro feito antes
 *   da pessoa aparecer espera a primeira aula.
 *
 * UMA VEZ POR ALUNO
 *   A marca fica no volume. Sair do experimental e voltar não repete o envio.
 *
 * SUBSTITUI A CONQUISTA "PRIMEIRA AULA"
 *   Com este aviso ligado, `conquistas-mensagens.js` pula o marco de 1 aula de
 *   quem é experimental — as duas mensagens diriam quase a mesma coisa no
 *   mesmo dia. Desligado aqui, a conquista volta a sair normalmente.
 *
 * A PRIMEIRA EXECUÇÃO NÃO ENVIA NADA
 *   Quem já está como experimental no dia do deploy é só anotado. Sem isto,
 *   subir o recurso mandaria "obrigado por ter vindo" para quem veio há semanas.
 *
 * CADASTRO ANTIGO NÃO RECEBE
 *   Ficha criada há mais de `diasMaximos` dias (telefone preenchido muito
 *   depois, por exemplo) é anotada sem envio: o agradecimento perderia o
 *   sentido.
 *
 * HORÁRIO
 *   Só sai entre `inicio` e `fim`. Fora disso fica para a primeira passada
 *   dentro da janela — ninguém recebe "obrigado" às 23h.
 *
 * QUEM CHAMA
 *   `gatilhos-mensagens.js` (aula nova ou cadastro/edição de matrícula, ~90 s
 *   depois) e a varredura a cada 5 min abaixo, que pega telefone preenchido
 *   depois e o que ficou fora da janela.
 */

const fs = require('fs');
const path = require('path');

const config = require('./config');
const historico = require('./historico-aulas');
const matriculas = require('./matriculas-store');
const modelos = require('./mensagens-store');
const telefone = require('./telefone');
const poller = require('./poller-portal');
const { enviarTexto, preencher } = require('./mensageiro');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ARQUIVO = path.join(DIR, 'experimental-avisados.json');

const TEXTO_PADRAO = 'Oi, {{nome}}! 👋\n\n'
  + 'Obrigado por ter vindo treinar com a gente{{noEstudio}}. Foi muito bom ter você aqui!\n\n'
  + 'Esperamos te ver de novo em breve — quando quiser combinar seus horários fixos, '
  + 'é só responder por aqui. 💪';

function log(...a) { console.log(new Date().toISOString(), '[experimental]', ...a); }

function dormir(ms) { return new Promise((r) => setTimeout(r, ms)); }

function cfg() {
  try { return config.ler().experimentalAviso || {}; } catch (e) { return {}; }
}

function ativo() { return cfg().ativo !== false; }

function hhmm(v, padrao) {
  const s = String(v || '');
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : padrao;
}

function inicio() { return hhmm(cfg().inicio, '08:00'); }
function fim() { return hhmm(cfg().fim, '21:00'); }

function diasMaximos() {
  const n = Number(cfg().diasMaximos);
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : 7;
}

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

function dentroDaJanela() {
  const h = agoraHHMM();
  return h >= inicio() && h < fim();
}

/* -------------------------------- estado --------------------------------- */

let estado = { semeadoEm: null, porMatricula: {} };

(function carregar() {
  try {
    const bruto = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
    estado.semeadoEm = bruto.semeadoEm || null;
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

function anotar(matriculaId, como) {
  estado.porMatricula[matriculaId] = { em: new Date().toISOString(), como };
}

/* -------------------------------- texto ---------------------------------- */

function primeiroNome(nome) {
  return String(nome || '').trim().split(/\s+/)[0] || '';
}

function nomeDoEstudio() {
  try { return String((config.ler().estudio || {}).nome || '').trim(); } catch (e) { return ''; }
}

function montarTexto(ficha) {
  const estudio = nomeDoEstudio();
  return preencher(modeloTexto(), {
    nome: primeiroNome(ficha.nome),
    nomeCompleto: ficha.nome || '',
    estudio,
    // Evita "com a gente no ." quando o nome do estúdio está em branco.
    noEstudio: estudio ? ` no ${estudio}` : '',
  });
}

/* -------------------------------- envio ---------------------------------- */

async function avisarGrupo(saiu) {
  if (cfg().avisarGrupo === false || !saiu.length) return;
  const corpo = [
    saiu.length === 1 ? '👋 Boas-vindas ao experimental' : `👋 Boas-vindas ao experimental (${saiu.length})`,
    '',
    ...saiu.map((s) => `• ${s.nome}`),
    '',
    'A mensagem de agradecimento já foi para o WhatsApp de cada um.',
  ];
  try { await poller.enviarWhatsApp(corpo.join('\n')); }
  catch (e) { log('não consegui avisar o grupo —', e.message); }
}

/**
 * Uma passada completa.
 * @param {object} opcoes
 * @param {boolean} opcoes.avisar  `false` devolve o que sairia, sem enviar nem anotar.
 * @param {boolean} opcoes.ignorarJanela  envio manual pela tela, fora do horário.
 */
async function rodarAgora(opcoes = {}) {
  const simulacao = opcoes.avisar === false;
  const semear = !estado.semeadoEm;
  const limiteMs = diasMaximos() * 86400000;
  const agora = Date.now();

  const pendentes = [];
  const expirados = [];
  for (const ficha of matriculas.listar()) {
    if (!ficha.ativo || !ficha.experimental) continue;
    if (estado.porMatricula[ficha.id]) continue;

    if (semear) { if (!simulacao) anotar(ficha.id, 'semeado'); pendentes.push({ nome: ficha.nome }); continue; }

    const criado = Date.parse(ficha.criadoEm || '');
    if (Number.isFinite(criado) && agora - criado > limiteMs) {
      expirados.push(ficha);
      continue;
    }

    const aulas = historico.total(ficha.id);
    if (!aulas) continue;   // ainda não veio: espera a primeira aula

    pendentes.push({
      matriculaId: ficha.id,
      nome: ficha.nome,
      telefone: telefone.normalizar(ficha.telefone),
      aulas,
      texto: montarTexto(ficha),
    });
  }

  if (semear) {
    if (simulacao) return { simulacao: true, seraSemeado: true, enviados: 0, pendentes };
    estado.semeadoEm = new Date().toISOString();
    gravar();
    log(`primeira passada: ${pendentes.length} experimental(is) anotado(s), nenhuma mensagem enviada.`);
    return { semeado: true, enviados: 0, anotadas: pendentes.length, pendentes: [] };
  }

  if (simulacao) {
    return { simulacao: true, enviados: 0, pendentes, foraDaJanela: !dentroDaJanela() };
  }

  if (expirados.length) {
    for (const f of expirados) anotar(f.id, 'expirado');
    gravar();
  }

  if (!pendentes.length) return { enviados: 0, falhas: 0, pendentes };
  if (!opcoes.ignorarJanela && !dentroDaJanela()) {
    return { enviados: 0, falhas: 0, pendentes, adiado: `fora da janela ${inicio()}–${fim()}` };
  }

  let enviados = 0;
  const falhas = [];
  const saiu = [];
  for (const p of pendentes) {
    // Sem telefone não se anota: preenchido o cadastro, sai na passada seguinte.
    if (!p.telefone) { falhas.push({ ...p, motivo: 'sem telefone' }); continue; }

    const r = await enviarTexto(p.telefone, p.texto);
    if (r.ok) { enviados++; saiu.push(p); anotar(p.matriculaId, 'enviado'); gravar(); }
    else falhas.push({ ...p, motivo: r.motivo });

    modelos.registrar({
      matriculaId: p.matriculaId, nome: p.nome, telefone: p.telefone, texto: p.texto,
      modeloId: null, modeloNome: 'Boas-vindas ao experimental', origem: 'experimental',
      ok: r.ok, motivo: r.ok ? null : r.motivo,
    });

    await dormir(pausaMs());
  }

  // "Sem telefone" é o estado normal de quem veio pelo check-in órfão; não
  // polui o log a cada 5 min — só falha de envio de verdade aparece.
  const reais = falhas.filter((f) => f.motivo !== 'sem telefone');
  if (reais.length) log(`${reais.length} não saiu/saíram:`,
    reais.map((f) => `${f.nome} (${f.motivo})`).join('; '));
  if (enviados) log(`${enviados} boas-vindas enviada(s).`);
  await avisarGrupo(saiu);

  return { enviados, falhas: falhas.length, pendentes, detalheFalhas: falhas };
}

/** Uma passada por vez: gatilho e varredura não podem ver o mesmo pendente juntos. */
let fila = Promise.resolve();
function rodar(opcoes = {}) {
  const vez = fila.then(() => rodarAgora(opcoes));
  fila = vez.catch(() => {});
  return vez;
}

/* ------------------------------ agendador -------------------------------- */

function iniciar() {
  log(`varredura a cada 5 min, envio entre ${inicio()} e ${fim()}`
    + `${ativo() ? '' : ' — DESLIGADO na configuração'}.`);

  const tentar = async () => {
    if (!ativo()) return;
    try { await rodar({}); } catch (e) { log('falhou:', e.message); }
  };

  // Depois das conquistas (120 s) e da meta (180 s), para não disputarem o
  // WhatsApp no mesmo minuto após um deploy.
  setTimeout(tentar, 240000).unref?.();
  setInterval(tentar, 5 * 60000).unref();
}

function situacao() {
  const contagem = { enviado: 0, semeado: 0, expirado: 0 };
  for (const v of Object.values(estado.porMatricula)) {
    if (v && contagem[v.como] !== undefined) contagem[v.como]++;
  }
  return {
    ativo: ativo(),
    inicio: inicio(),
    fim: fim(),
    diasMaximos: diasMaximos(),
    avisarGrupo: cfg().avisarGrupo !== false,
    semeadoEm: estado.semeadoEm,
    ...contagem,
    textoPadrao: TEXTO_PADRAO,
  };
}

module.exports = { iniciar, rodar, situacao, ativo, TEXTO_PADRAO };
