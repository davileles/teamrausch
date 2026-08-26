'use strict';

/**
 * app/src/frequencia.js — davileles/teamrausch
 *
 * Compara o que foi combinado com o que aconteceu.
 *
 * A PERGUNTA QUE ISTO RESPONDE
 *   "Passados sete dias, um aluno que treina duas vezes por semana fez pelo
 *   menos dois check-ins?" Quem não fez está atrasado e é cobrado agora, não no
 *   fim do mês, quando não há mais como repor.
 *
 * O COMBINADO NÃO É UM NÚMERO SOLTO
 *   Poderíamos comparar os check-ins contra `diasPorSemana` da matrícula, mas
 *   isso erraria em toda semana com feriado, viagem avisada ou aula extra
 *   encaixada. O esperado é a projeção real da grade sobre os dias da janela,
 *   já descontadas as aulas desmarcadas e somadas as extras — a mesma função
 *   que desenha a tela "Grade do dia". Aluno que avisou que não vinha na terça
 *   não vira devedor por causa disso.
 *
 * AULA DE HOJE AINDA NÃO É FALTA
 *   A janela termina hoje, mas a aula das 19h não pode ser cobrada às 10h da
 *   manhã. Só entram no esperado as aulas cujo horário já passou (com uma
 *   folga, porque o check-in acontece na chegada e nem todo mundo é pontual).
 *   Sem isso, todo aluno com aula à noite apareceria atrasado a manhã inteira.
 *
 * CHECK-IN VALE UM POR DIA
 *   `checkins-store` já deduplica por dia; aqui só contamos as datas distintas.
 *
 * A JANELA NUNCA ATRAVESSA A VIRADA DE MÊS
 *   O pacote do aluno se renova no dia 1º: o que ele deixou de fazer em agosto
 *   fechou em agosto e não é cobrado de novo em setembro. Uma janela móvel de
 *   sete dias corridos, olhada no dia 3, enxergaria 28/08 a 03/09 e traria
 *   faltas de um ciclo já encerrado para dentro do novo — o aluno começaria o
 *   mês devendo. Por isso a janela é truncada no primeiro dia do mês: no dia 3
 *   ela vale três dias, no dia 8 já vale os sete inteiros.
 *
 *   O efeito colateral é conhecido e desejado: no começo do mês quase ninguém
 *   aparece como atrasado, porque quase não houve mês ainda. Para não perder o
 *   mês de vista, cada aluno também traz o acumulado desde o dia 1º (`mes`),
 *   que é o número que conta no fechamento.
 */

const grade = require('./grade');

const FUSO = process.env.TZ_ESTUDIO || 'America/Sao_Paulo';
/** Folga depois do horário da aula antes de considerá-la cobrável (minutos). */
const TOLERANCIA_MIN = Number(process.env.FREQ_TOLERANCIA_MIN || 90);
/** Semanas cobradas num mês, do jeito que o pacote é vendido. */
const SEMANAS_NO_MES = Number(process.env.FREQ_SEMANAS_MES || 4);
/** Teto de check-ins por semana que o Wellhub repassa (12 no mês ÷ 4 semanas). */
const TETO_SEMANAL = Number(process.env.FREQ_TETO_SEMANAL || 3);

function hojeLocal() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function agoraEmMinutos() {
  const [h, m] = new Intl.DateTimeFormat('en-GB', {
    timeZone: FUSO, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date()).split(':');
  return Number(h) * 60 + Number(m);
}

/** Primeiro dia do mês da data — o piso de qualquer janela. */
function inicioDoMes(data) {
  return String(data).slice(0, 8) + '01';
}

/** Último dia do mês da data — o prazo do pacote. */
function fimDoMes(data) {
  const [ano, mes] = String(data).split('-').map(Number);
  const ultimo = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  return `${String(ano)}-${String(mes).padStart(2, '0')}-${String(ultimo)}`;
}

/**
 * Meta do mês: o combinado semanal multiplicado por quatro, limitado a 12.
 *
 * O pacote é vendido assim — 1x por semana são 4 no mês, 2x são 8, 3x são 12 —
 * e não por dia de calendário. Contar as ocorrências reais de cada dia da
 * semana daria 13 para quem treina segunda, quarta e sexta em agosto (que tem
 * cinco segundas), cobrando um treino que o aluno não contratou.
 *
 * O TETO DE TRÊS POR SEMANA É FINANCEIRO, NÃO DE TREINO
 *   O Wellhub repassa no máximo 12 check-ins por mês. Quem treina de segunda a
 *   sexta continua vindo cinco vezes, mas do 13º check-in em diante não entra
 *   nada — essas aulas o aluno paga direto ao estúdio. Cobrar 20 check-ins dele
 *   seria cobrar oito que não geram receita nenhuma.
 *
 * Vem da grade, e não de um número guardado na ficha: `diasPorSemana` conta
 * dias distintos, então quem tem dois horários na mesma terça continua sendo
 * 1x por semana.
 */
function metaDoMes(matricula) {
  const porSemana = Math.min(grade.diasPorSemana(matricula), TETO_SEMANAL);
  return porSemana * SEMANAS_NO_MES;
}

function emMinutos(hora) {
  const [h, m] = String(hora || '00:00').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * Aulas previstas de uma matrícula entre duas datas, contando só as que já
 * deveriam ter acontecido. Devolve a lista de `{ data, hora, origem }`.
 */
function aulasPrevistas(matricula, excecoes, { de, ate }) {
  const hoje = hojeLocal();
  const limiteHoje = agoraEmMinutos() - TOLERANCIA_MIN;
  const minhas = (excecoes || []).filter((e) => e.matriculaId === matricula.id);
  const out = [];

  let data = de;
  while (data <= ate) {
    const dow = grade.diaDaSemana(data);
    const cancelou = (hora) => minhas.some((e) =>
      e.tipo === 'cancelou' && e.data === data && (!e.hora || e.hora === hora));

    const passou = (hora) => data < hoje || (data === hoje && emMinutos(hora) <= limiteHoje);

    for (const slot of grade.gradeVigente(matricula, data)) {
      if (slot.dia !== dow) continue;
      if (cancelou(slot.hora)) continue;
      if (!passou(slot.hora)) continue;
      out.push({ data, hora: slot.hora, origem: 'fixo' });
    }
    for (const e of minhas) {
      if (e.tipo !== 'extra' || e.data !== data || !e.hora) continue;
      if (cancelou(e.hora)) continue;
      if (!passou(e.hora)) continue;
      out.push({ data, hora: e.hora, origem: 'extra' });
    }
    data = grade.somarDias(data, 1);
  }

  out.sort((a, b) => a.data.localeCompare(b.data) || a.hora.localeCompare(b.hora));
  return out;
}

/**
 * Situação de uma matrícula na janela.
 *
 * @param matricula   registro de matriculas-store
 * @param datasFeitas datas (YYYY-MM-DD) em que houve check-in, qualquer ordem
 * @param excecoes    exceções do período
 * @param opcoes      { dias = 7, ate = hoje }
 */
function avaliar(matricula, datasFeitas = [], excecoes = [], opcoes = {}) {
  const dias = Number(opcoes.dias) > 0 ? Number(opcoes.dias) : 7;
  const ate = opcoes.ate || hojeLocal();
  const primeiroDoMes = inicioDoMes(ate);

  // O piso é o dia 1º. Pedir 7 dias no dia 3 devolve uma janela de 3 dias, não
  // uma que invade o mês anterior.
  const corrido = grade.somarDias(ate, -(dias - 1));
  const de = corrido < primeiroDoMes ? primeiroDoMes : corrido;
  const diasNaJanela = diferencaEmDias(de, ate) + 1;

  const previstas = aulasPrevistas(matricula, excecoes, { de, ate });
  // Um dia com dois check-ins não vira dois créditos: a grade também conta
  // dias, não aparições.
  const feitas = [...new Set(datasFeitas.filter((d) => d >= de && d <= ate))].sort();

  const realizado = feitas.length;

  // Acumulado do ciclo inteiro. Quando a janela já cobre o mês todo (começo de
  // mês), é o mesmo número — e não custa recalcular.
  const previstasMes = de === primeiroDoMes
    ? previstas
    : aulasPrevistas(matricula, excecoes, { de: primeiroDoMes, ate });
  const feitasMes = [...new Set(
    datasFeitas.filter((d) => d >= primeiroDoMes && d <= ate))].sort();

  const metaMes = metaDoMes(matricula);
  const faltamNoMes = Math.max(metaMes - feitasMes.length, 0);

  // O QUE SE PODE COBRAR NUNCA PASSA DO QUE FALTA NO MÊS
  //   Quem treina de segunda a sexta tem cinco aulas previstas na semana, mas o
  //   Wellhub só repassa doze no mês. Batidos os doze, ele continua vindo e o
  //   check-in dele para de existir — pelo cálculo antigo isso virava saldo -3 e
  //   a pessoa mais assídua do estúdio aparecia como crítica. Limitar o esperado
  //   ao que ainda falta faz a cobrança bater com a realidade do repasse.
  const esperado = metaMes ? Math.min(previstas.length, faltamNoMes) : previstas.length;
  const saldo = realizado - esperado;

  const todas = [...new Set(datasFeitas)].sort();
  const ultimo = todas.length ? todas[todas.length - 1] : null;
  const diasSemTreinar = ultimo ? diferencaEmDias(ultimo, ate) : null;

  return {
    matriculaId: matricula.id,
    nome: matricula.nome,
    telefone: matricula.telefone || null,
    vinculo: matricula.vinculo || null,
    experimental: Boolean(matricula.experimental),
    gympassId: matricula.gympassId || null,
    janela: {
      de, ate,
      dias: diasNaJanela,
      diasPedidos: dias,
      // A tela usa isto para explicar por que a janela está curta em vez de
      // deixar o número menor parecer bug.
      truncadaNoMes: diasNaJanela < dias,
    },
    mes: {
      de: primeiroDoMes,
      ate,
      fecha: fimDoMes(ate),
      esperado: previstasMes.length,
      realizado: feitasMes.length,
      saldo: feitasMes.length - previstasMes.length,
      // O que conta no fechamento: quantos treinos o pacote pede no mês e
      // quantos ainda cabem até o dia 31. `esperado`/`saldo` acima olham a
      // grade projetada e servem para cobrar no meio do caminho; `meta` e
      // `faltam` são o número do fim do mês.
      meta: metaMes,
      faltam: faltamNoMes,
      // Quantos check-ins por semana valem no financeiro, já com o teto
      // aplicado. A tela usa isto para não parecer que a grade do aluno mudou.
      porSemanaCobravel: Math.min(grade.diasPorSemana(matricula), TETO_SEMANAL),
      acimaDoTeto: grade.diasPorSemana(matricula) > TETO_SEMANAL,
      // Aulas previstas na janela que já não geram check-in porque o pacote
      // acabou. Existem, o aluno vem, mas o repasse não cobre.
      forasDoPacote: metaMes ? Math.max(previstas.length - faltamNoMes, 0) : 0,
    },
    porSemana: grade.diasPorSemana(matricula),
    semGrade: !(matricula.grade || []).length,
    esperado,
    realizado,
    saldo,
    situacao: classificar(saldo, esperado, matricula, { metaMes, faltamNoMes }),
    previstas,
    datas: feitas,
    ultimoCheckin: ultimo,
    diasSemTreinar,
  };
}

/**
 * `em-dia` cobre também quem treinou mais do que devia — não é problema a ser
 * sinalizado aqui. `atrasado` é uma aula de diferença; `critico`, duas ou mais,
 * que numa semana de duas aulas significa que a pessoa sumiu.
 */
function classificar(saldo, esperado, matricula, mes = {}) {
  // Experimental vem antes de tudo: quem está em teste não tem grade ainda e
  // seria classificado como 'sem-grade', que na tela parece cadastro pela
  // metade. Também não pode virar devedor — não há combinado para cobrar.
  if (matricula.experimental) return 'experimental';
  if (!(matricula.grade || []).length) return 'sem-grade';
  // Pacote fechado: os doze do mês saíram e não há mais check-in a cobrar.
  // Fica antes do saldo de propósito — é o estado final do ciclo, e cobrar
  // alguém que já entregou tudo é o erro mais caro que esta tela pode cometer.
  if (mes.metaMes && mes.faltamNoMes === 0) return 'quitado';
  if (!esperado) return 'sem-aula';       // janela sem nenhuma aula prevista
  if (saldo >= 0) return 'em-dia';
  return saldo <= -2 ? 'critico' : 'atrasado';
}

function diferencaEmDias(de, ate) {
  const [a1, m1, d1] = String(de).split('-').map(Number);
  const [a2, m2, d2] = String(ate).split('-').map(Number);
  return Math.round((Date.UTC(a2, m2 - 1, d2) - Date.UTC(a1, m1 - 1, d1)) / 86400000);
}

const ORDEM = { critico: 0, atrasado: 1, experimental: 2, 'sem-aula': 3,
  'em-dia': 4, quitado: 5, 'sem-grade': 6 };

/**
 * Painel completo. `mapaDatas` é o Map matriculaId → datas de `checkins-store`.
 *
 * Por padrão avalia só quem é Wellhub: mensalista não faz check-in no portal,
 * então o realizado dele seria sempre zero e a lista de atrasados viraria a
 * base inteira. Passe `vinculo: null` para avaliar todo mundo.
 */
function painel(matriculas, mapaDatas, excecoes, opcoes = {}) {
  const vinculo = opcoes.vinculo === undefined ? 'wellhub' : opcoes.vinculo;
  const lista = matriculas
    .filter((m) => m.ativo && (!vinculo || m.vinculo === vinculo))
    .map((m) => avaliar(m, mapaDatas.get(m.id) || [], excecoes, opcoes));

  lista.sort((a, b) =>
    (ORDEM[a.situacao] - ORDEM[b.situacao]) ||
    (a.saldo - b.saldo) ||
    a.nome.localeCompare(b.nome, 'pt-BR'));

  const conta = (s) => lista.filter((x) => x.situacao === s).length;
  // Sem nenhum aluno avaliado ainda assim precisamos devolver a janela real,
  // senão a tela mostraria "últimos 7 dias" num dia 2 do mês.
  const ateRef = opcoes.ate || hojeLocal();
  const pedidos = Number(opcoes.dias) > 0 ? Number(opcoes.dias) : 7;
  const corridoRef = grade.somarDias(ateRef, -(pedidos - 1));
  const deRef = corridoRef < inicioDoMes(ateRef) ? inicioDoMes(ateRef) : corridoRef;

  return {
    janela: lista.length ? lista[0].janela : {
      de: deRef, ate: ateRef,
      dias: diferencaEmDias(deRef, ateRef) + 1,
      diasPedidos: pedidos,
      truncadaNoMes: deRef > corridoRef,
    },
    resumo: {
      avaliados: lista.length,
      // Fechamento do mês: soma do que cada aluno ainda deve para bater o
      // pacote. É o número que responde "quantos treinos faltam até o dia 31".
      metaMes: lista.reduce((s, a) => s + a.mes.meta, 0),
      realizadoMes: lista.reduce((s, a) => s + a.mes.realizado, 0),
      faltamMes: lista.reduce((s, a) => s + a.mes.faltam, 0),
      devendoNoMes: lista.filter((a) => a.mes.faltam > 0 && a.mes.meta > 0).length,
      emDia: conta('em-dia'),
      quitados: conta('quitado'),
      atrasados: conta('atrasado'),
      criticos: conta('critico'),
      semGrade: conta('sem-grade'),
      semAula: conta('sem-aula'),
      experimentais: conta('experimental'),
    },
    alunos: lista,
  };
}

/** Só quem precisa de cobrança — é a lista que vai para o aviso diário. */
function devedores(painelPronto) {
  return painelPronto.alunos.filter((a) =>
    a.situacao === 'atrasado' || a.situacao === 'critico');
}

module.exports = {
  avaliar, painel, devedores, aulasPrevistas, metaDoMes,
  hojeLocal, agoraEmMinutos, inicioDoMes, fimDoMes,
  TOLERANCIA_MIN, SEMANAS_NO_MES, TETO_SEMANAL,
};
