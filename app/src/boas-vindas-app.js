'use strict';

/**
 * app/src/boas-vindas-app.js — davileles/teamrausch
 *
 * Mensagem de boas-vindas com as instruções do app, para quem passa a ter
 * grade fixa: mostra os horários salvos, explica que não precisa agendar todo
 * dia, que o app serve para trocar de horário (com o prazo do estúdio) e deixa
 * o link guardado na conversa.
 *
 * QUANDO SAI
 *   1. Login com grade escolhida no app (`enviarPorTelefone`, chamado por
 *      `/auth/entrar`). Cobre três casos: primeiro acesso de aluno novo, aluno
 *      antigo da planilha confirmando a grade na primeira entrada e
 *      experimental que volta e cadastra os horários.
 *   2. Experimental que virou aluno pelo painel (`rodar`). A varredura pega
 *      ficha ativa, sem marca de experimental, com grade e com `alunoDesde`
 *      nos últimos `diasMaximos` dias — `alunoDesde` só é gravado na virada.
 *
 * O EXPERIMENTAL NÃO RECEBE ESTA
 *   Quem está em aula experimental continua só com o agradecimento de
 *   `boas-vindas-experimental.js`. Esta sai quando ele vira aluno.
 *
 * UMA VEZ POR MATRÍCULA
 *   A marca fica no volume. Envio que falhou no login fica "pendente" e a
 *   varredura tenta de novo dentro do prazo.
 *
 * A PRIMEIRA VARREDURA NÃO ENVIA NADA
 *   Quem virou aluno nos dias antes do deploy é só anotado — não recebe
 *   "bem-vindo" atrasado. Isso não bloqueia o envio pelo login.
 *
 * HORÁRIO
 *   O envio pelo login é imediato (responde a uma ação da pessoa). A varredura
 *   só envia entre `inicio` e `fim`.
 */

const fs = require('fs');
const path = require('path');

const config = require('./config');
const matriculas = require('./matriculas-store');
const modelos = require('./mensagens-store');
const telefone = require('./telefone');
const grade = require('./grade');
const { enviarTexto, preencher } = require('./mensageiro');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ARQUIVO = path.join(DIR, 'boas-vindas-app.json');

const LINK_PADRAO = 'https://app.teamrausch.com.br';

const TEXTO_PADRAO = 'Olá, *{{nome}}*! 👋 Seja bem-vindo(a) ao *{{estudio}}*!\n\n'
  + 'Seus horários fixos estão salvos:\n{{grade}}\n\n'
  + '✅ *Você não precisa agendar todo dia.* Sua vaga nesses horários já está garantida toda semana.\n\n'
  + '📲 *Use o app só para trocar de horário.* Se num dia não puder vir no horário de sempre, '
  + 'abra o app e escolha outro horário livre. Dá para ver quantas pessoas já estão agendadas em cada turma.\n\n'
  + '⏰ A troca precisa ser feita com pelo menos *{{prazoTroca}}* de antecedência do seu horário original.\n\n'
  + 'Guarde esta mensagem para ter o link sempre à mão:\n👉 {{link}}\n\n'
  + 'Bons treinos! 💪';

function log(...a) { console.log(new Date().toISOString(), '[boas-vindas-app]', ...a); }

function cfg() {
  try { return config.ler().boasVindasApp || {}; } catch (e) { return {}; }
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
function link() { return String(cfg().link || '').trim() || LINK_PADRAO; }

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

function hojeISO() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.TZ_ESTUDIO || 'America/Sao_Paulo',
  }).format(new Date());
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

function marca(matriculaId) { return estado.porMatricula[matriculaId] || null; }

/* -------------------------------- texto ---------------------------------- */

function primeiroNome(nome) {
  return String(nome || '').trim().split(/\s+/)[0] || '';
}

function nomeDoEstudio() {
  try { return String((config.ler().estudio || {}).nome || '').trim(); } catch (e) { return ''; }
}

function textoDaGrade(lista) {
  return [...(lista || [])]
    .sort((a, b) => (a.dia - b.dia) || String(a.hora).localeCompare(String(b.hora)))
    .map((s) => {
      const dia = grade.NOME_DIA[s.dia] || '';
      return `• ${dia.charAt(0).toUpperCase()}${dia.slice(1)} às ${s.hora}`;
    })
    .join('\n');
}

/** Mesmo texto que o app mostra ao travar a troca ("2 horas", "30 minutos"). */
function prazoTroca() {
  let n;
  try { n = Number(config.ler().agenda.minutosParaCancelar) || 0; } catch (e) { n = 0; }
  if (n < 60) return `${n} minutos`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  if (m) return `${h}h${String(m).padStart(2, '0')}`;
  return h === 1 ? '1 hora' : `${h} horas`;
}

function montarTexto(ficha) {
  return preencher(modeloTexto(), {
    nome: primeiroNome(ficha.nome),
    nomeCompleto: ficha.nome || '',
    estudio: nomeDoEstudio() || 'estúdio',
    grade: textoDaGrade(ficha.grade),
    prazoTroca: prazoTroca(),
    link: link(),
  });
}

/** Ficha que merece a mensagem: ativa, aluno de verdade, com grade e telefone. */
function elegivel(ficha) {
  return ficha && ficha.ativo !== false && !ficha.experimental
    && (ficha.grade || []).length > 0;
}

/* -------------------------------- envio ---------------------------------- */

async function enviar(ficha, origem) {
  const numero = telefone.normalizar(ficha.telefone);
  if (!numero) return { ok: false, motivo: 'sem telefone' };
  const texto = montarTexto(ficha);
  const r = await enviarTexto(numero, texto);
  modelos.registrar({
    matriculaId: ficha.id, nome: ficha.nome, telefone: numero, texto,
    modeloId: null, modeloNome: 'Boas-vindas ao app', origem: 'boas-vindas-app',
    ok: r.ok, motivo: r.ok ? null : r.motivo,
  });
  if (r.ok) log(`enviada para ${ficha.nome} (${origem}).`);
  else log(`não saiu para ${ficha.nome} (${origem}): ${r.motivo}`);
  return r;
}

/** Uma operação por vez: login e varredura não podem enviar para a mesma ficha juntos. */
let fila = Promise.resolve();
function naFila(fn) {
  const vez = fila.then(fn);
  fila = vez.catch(() => {});
  return vez;
}

/**
 * Login com grade escolhida. Não espera o envio: quem chama responde ao app
 * na hora e a mensagem sai em seguida.
 */
function enviarPorTelefone(tel) {
  if (!ativo()) return;
  naFila(async () => {
    const ficha = matriculas.porTelefone(tel);
    if (!elegivel(ficha)) return;
    // Só "enviado" bloqueia: a semeadura é da varredura, e o aluno antigo que
    // confirma a grade no primeiro acesso ainda tem direito à mensagem.
    if ((marca(ficha.id) || {}).como === 'enviado') return;
    const r = await enviar(ficha, 'login');
    anotar(ficha.id, r.ok ? 'enviado' : 'pendente');
    gravar();
  }).catch((e) => log('falhou:', e.message));
}

/**
 * Varredura: experimental que virou aluno pelo painel e envio do login que
 * ficou pendente.
 * @param {object} opcoes
 * @param {boolean} opcoes.avisar  `false` devolve o que sairia, sem enviar nem anotar.
 * @param {boolean} opcoes.ignorarJanela  envio manual pela tela, fora do horário.
 */
async function rodarAgora(opcoes = {}) {
  const simulacao = opcoes.avisar === false;
  const semear = !estado.semeadoEm;
  const limiteMs = diasMaximos() * 86400000;
  const hoje = Date.parse(`${hojeISO()}T12:00:00Z`);
  const agora = Date.now();

  const pendentes = [];
  for (const ficha of matriculas.listar()) {
    if (!elegivel(ficha)) continue;
    const m = marca(ficha.id);
    if (m && m.como !== 'pendente') continue;

    let dentroDoPrazo;
    if (m) {
      dentroDoPrazo = agora - Date.parse(m.em) <= limiteMs;
    } else {
      const desde = Date.parse(`${String(ficha.alunoDesde || '').slice(0, 10)}T12:00:00Z`);
      dentroDoPrazo = Number.isFinite(desde) && hoje - desde <= limiteMs;
    }
    if (!dentroDoPrazo) continue;

    pendentes.push({
      ficha,
      matriculaId: ficha.id,
      nome: ficha.nome,
      telefone: telefone.normalizar(ficha.telefone),
      texto: montarTexto(ficha),
    });
  }
  const semFicha = (p) => { const { ficha, ...resto } = p; return resto; };

  if (semear) {
    if (simulacao) return { simulacao: true, seraSemeado: true, enviados: 0, pendentes: pendentes.map(semFicha) };
    for (const p of pendentes) anotar(p.matriculaId, 'semeado');
    estado.semeadoEm = new Date().toISOString();
    gravar();
    log(`primeira passada: ${pendentes.length} aluno(s) anotado(s), nenhuma mensagem enviada.`);
    return { semeado: true, enviados: 0, anotadas: pendentes.length, pendentes: [] };
  }

  if (simulacao) {
    return { simulacao: true, enviados: 0, pendentes: pendentes.map(semFicha), foraDaJanela: !dentroDaJanela() };
  }
  if (!pendentes.length) return { enviados: 0, falhas: 0, pendentes: [] };
  if (!opcoes.ignorarJanela && !dentroDaJanela()) {
    return { enviados: 0, falhas: 0, pendentes: pendentes.map(semFicha), adiado: `fora da janela ${inicio()}–${fim()}` };
  }

  let enviados = 0;
  const falhas = [];
  for (const p of pendentes) {
    // Sem telefone não se anota: preenchido o cadastro, sai na passada seguinte.
    if (!p.telefone) { falhas.push({ nome: p.nome, motivo: 'sem telefone' }); continue; }
    const r = await enviar(p.ficha, 'varredura');
    if (r.ok) { enviados++; anotar(p.matriculaId, 'enviado'); gravar(); }
    else falhas.push({ nome: p.nome, motivo: r.motivo });
    await new Promise((ok) => setTimeout(ok, 8000));
  }
  return { enviados, falhas: falhas.length, pendentes: pendentes.map(semFicha), detalheFalhas: falhas };
}

function rodar(opcoes = {}) { return naFila(() => rodarAgora(opcoes)); }

/* ------------------------------ agendador -------------------------------- */

function iniciar() {
  log(`varredura a cada 5 min, envio entre ${inicio()} e ${fim()}`
    + `${ativo() ? '' : ' — DESLIGADO na configuração'}.`);
  const tentar = async () => {
    if (!ativo()) return;
    try { await rodar({}); } catch (e) { log('falhou:', e.message); }
  };
  // Depois da boas-vindas do experimental (240 s), para não disputarem o WhatsApp.
  setTimeout(tentar, 300000).unref?.();
  setInterval(tentar, 5 * 60000).unref();
}

function situacao() {
  const contagem = { enviado: 0, semeado: 0, pendente: 0 };
  for (const v of Object.values(estado.porMatricula)) {
    if (v && contagem[v.como] !== undefined) contagem[v.como]++;
  }
  return {
    ativo: ativo(),
    inicio: inicio(),
    fim: fim(),
    diasMaximos: diasMaximos(),
    link: link(),
    semeadoEm: estado.semeadoEm,
    ...contagem,
    textoPadrao: TEXTO_PADRAO,
  };
}

module.exports = { iniciar, rodar, situacao, ativo, enviarPorTelefone, TEXTO_PADRAO };
