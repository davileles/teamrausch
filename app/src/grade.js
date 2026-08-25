'use strict';

/**
 * app/src/grade.js — davileles/teamrausch
 *
 * Projeta a grade fixa das matrículas sobre uma data, aplicando exceções.
 *
 * Nenhuma aula futura é gravada em disco: a agenda de qualquer dia é calculada
 * na hora a partir de (matricula.grade + exceções daquela data). Gravar 120
 * alunos × 5 dias × 52 semanas seria trinta mil registros para representar uma
 * informação que cabe em uma linha por aluno — e qualquer mudança de horário
 * exigiria reescrever o futuro inteiro.
 *
 * Estruturas esperadas:
 *
 *   matricula = {
 *     id, nome, telefone: null,
 *     ativo: true,
 *     vinculo: 'wellhub' | 'mensalista',
 *     ciclo: 'mensal'|'trimestral'|'semestral'|'anual',  // só mensalista
 *     diaVencimento: 26,                                  // só mensalista
 *     grade: [ { dia: 1, hora: '18:00' }, ... ],          // dia 0=dom … 6=sáb
 *     vigenteDe: '2026-08-24',
 *     gradeAnterior: [ { grade: [...], vigenteDe, vigenteAte } ]
 *   }
 *
 *   excecao = {
 *     id, matriculaId, data: 'YYYY-MM-DD',
 *     tipo: 'cancelou' | 'extra',
 *     hora: '19:00'   // obrigatório em 'extra'; em 'cancelou' limita a uma aula
 *   }
 */

const MS_DIA = 86400000;

/** 'YYYY-MM-DD' → dia da semana (0=dom … 6=sáb), sem depender do fuso do servidor. */
function diaDaSemana(data) {
  const [a, m, d] = String(data).split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d)).getUTCDay();
}

function somarDias(data, n) {
  const [a, m, d] = String(data).split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d) + n * MS_DIA).toISOString().slice(0, 10);
}

/** Datas em ISO comparam certo como texto — não precisa converter para Date. */
function noIntervalo(data, de, ate) {
  if (de && data < de) return false;
  if (ate && data > ate) return false;
  return true;
}

/**
 * Grade que estava valendo numa data específica.
 * Sem isto, mudar o horário de um aluno reescreveria o passado na tela de
 * histórico: a aula de três meses atrás apareceria no horário novo.
 */
function gradeVigente(matricula, data) {
  for (const h of matricula.gradeAnterior || []) {
    if (noIntervalo(data, h.vigenteDe, h.vigenteAte)) return h.grade || [];
  }
  if (matricula.vigenteDe && data < matricula.vigenteDe) return [];
  return matricula.grade || [];
}

/**
 * Agenda de um dia: lista de { hora, matriculaId, nome, vinculo, origem }.
 * origem: 'fixo' (veio da grade) | 'extra' (aula avulsa daquele dia).
 */
function agendaDoDia(matriculas, data, excecoes = []) {
  const dow = diaDaSemana(data);
  const doDia = excecoes.filter((e) => e.data === data);

  // Cancelamento sem hora derruba o dia inteiro do aluno; com hora, só aquela aula.
  const cancelados = doDia.filter((e) => e.tipo === 'cancelou');
  function cancelou(matriculaId, hora) {
    return cancelados.some((e) =>
      e.matriculaId === matriculaId && (!e.hora || e.hora === hora));
  }

  const itens = [];

  for (const m of matriculas) {
    // Inativo some da projeção. O passado continua íntegro porque é lido das
    // exceções e dos check-ins, não daqui.
    if (!m.ativo) continue;
    for (const slot of gradeVigente(m, data)) {
      if (slot.dia !== dow) continue;
      if (cancelou(m.id, slot.hora)) continue;
      itens.push({
        hora: slot.hora,
        matriculaId: m.id,
        nome: m.nome,
        telefone: m.telefone || null,
        vinculo: m.vinculo || null,
        origem: 'fixo',
      });
    }
  }

  for (const e of doDia) {
    if (e.tipo !== 'extra' || !e.hora) continue;
    const m = matriculas.find((x) => x.id === e.matriculaId);
    if (!m || !m.ativo) continue;
    // Uma aula extra também pode ser desmarcada depois de encaixada. Sem esta
    // linha o cancelamento era gravado e ignorado, e a aula continuava na tela.
    if (cancelou(m.id, e.hora)) continue;
    itens.push({
      hora: e.hora,
      matriculaId: m.id,
      nome: m.nome,
      telefone: m.telefone || null,
      vinculo: m.vinculo || null,
      origem: 'extra',
      excecaoId: e.id || null,
    });
  }

  itens.sort((a, b) =>
    a.hora.localeCompare(b.hora) || a.nome.localeCompare(b.nome, 'pt-BR'));
  return itens;
}

/** Mesma projeção agrupada por horário — formato da tela "Grade do dia". */
function agendaPorHorario(matriculas, data, excecoes = []) {
  const mapa = new Map();
  for (const item of agendaDoDia(matriculas, data, excecoes)) {
    if (!mapa.has(item.hora)) mapa.set(item.hora, []);
    mapa.get(item.hora).push(item);
  }
  return [...mapa.entries()]
    .map(([hora, alunos]) => ({ hora, total: alunos.length, alunos }))
    .sort((a, b) => a.hora.localeCompare(b.hora));
}

/** Próximas aulas de uma matrícula — usado na ficha do aluno. */
function proximasDaMatricula(matricula, excecoes, { de, dias = 14 } = {}) {
  if (!matricula.ativo) return [];
  const inicio = de || new Date().toISOString().slice(0, 10);

  const minhas = excecoes.filter((e) => e.matriculaId === matricula.id);
  const out = [];

  for (let i = 0; i < dias; i++) {
    const data = somarDias(inicio, i);
    const dow = diaDaSemana(data);
    const cancelou = (hora) => minhas.some((e) =>
      e.tipo === 'cancelou' && e.data === data && (!e.hora || e.hora === hora));

    for (const slot of gradeVigente(matricula, data)) {
      if (slot.dia !== dow || cancelou(slot.hora)) continue;
      out.push({ data, hora: slot.hora, origem: 'fixo' });
    }
    for (const e of minhas) {
      if (e.tipo === 'extra' && e.data === data && e.hora) {
        out.push({ data, hora: e.hora, origem: 'extra', excecaoId: e.id || null });
      }
    }
  }
  out.sort((x, y) => x.data.localeCompare(y.data) || x.hora.localeCompare(y.hora));
  return out;
}

/** Quantos dias por semana o aluno treina — derivado da grade, nunca armazenado. */
function diasPorSemana(matricula) {
  return new Set((matricula.grade || []).map((s) => s.dia)).size;
}

/**
 * Horário padrão do aluno em texto: '18:00 · seg, qua, sex'.
 * Agrupa por hora porque a grande maioria treina sempre no mesmo horário —
 * repetir a hora em cada dia só faria a linha crescer sem dizer mais nada.
 */
const ABREV_DIA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

function gradeEmTexto(matricula) {
  const porHora = new Map();
  for (const s of matricula.grade || []) {
    if (!porHora.has(s.hora)) porHora.set(s.hora, []);
    porHora.get(s.hora).push(s.dia);
  }
  return [...porHora.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([hora, dias]) =>
      `${hora} · ${dias.sort((x, y) => x - y).map((d) => ABREV_DIA[d]).join(', ')}`)
    .join('  |  ');
}

/** Ocupação de cada slot da semana — alimenta o mapa de lotação. */
function ocupacaoSemanal(matriculas) {
  const mapa = new Map();
  for (const m of matriculas) {
    if (!m.ativo) continue;
    for (const s of m.grade || []) {
      const chave = `${s.dia}|${s.hora}`;
      if (!mapa.has(chave)) mapa.set(chave, []);
      // Quem está na turma, e não só quantos: o mapa de lotação abre a célula
      // com os nomes, e refazer essa conta na tela exigiria baixar a base toda.
      mapa.get(chave).push({ id: m.id, nome: m.nome, vinculo: m.vinculo || 'mensalista' });
    }
  }
  return [...mapa.entries()]
    .map(([chave, alunos]) => {
      const [dia, hora] = chave.split('|');
      return { dia: Number(dia), hora, total: alunos.length, alunos };
    })
    .sort((a, b) => a.hora.localeCompare(b.hora) || a.dia - b.dia);
}

module.exports = {
  diaDaSemana, somarDias, gradeVigente,
  agendaDoDia, agendaPorHorario, proximasDaMatricula,
  diasPorSemana, gradeEmTexto, ocupacaoSemanal,
};
