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
/**
 * Teto de check-ins que o Wellhub repassa por aluno no mês.
 *
 * É um número fixo da assinatura, não da grade: quem contratou 1x por semana e
 * apareceu vinte vezes gera doze check-ins pagos, iguais aos de quem contratou
 * 3x. `metaDoMes` continua sendo o combinado de cada um — o que se cobra dele.
 * Este aqui é outro limite: o que o relatório pode contar como realizado.
 */
const TETO_MES = Number(process.env.FREQ_TETO_MES || TETO_SEMANAL * SEMANAS_NO_MES);

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

/**
 * Quanto o pacote já deveria ter rendido a esta altura do mês.
 *
 * O combinado é semanal, então a cobrança também é: quem faz 3x por semana
 * precisa ter 3 no dia 7, 6 no dia 14, 9 no dia 21 e os 12 no fechamento. Sem
 * esses marcos, um aluno pode passar três semanas sumido e ainda parecer em dia
 * porque "ainda dá tempo" — e no dia 28 não dá mais, com quatro reposições
 * empilhadas numa semana que só tem três vagas.
 *
 * A COTA VENCE NO FIM DA SEMANA, NÃO NO COMEÇO
 *   `Math.floor(dia / 7)` conta semanas fechadas: no dia 26 são três, e o
 *   exigido é 9. Cobrar 12 no dia 22 seria cobrar uma semana que mal começou.
 *
 * A ÚLTIMA COTA VENCE NO ÚLTIMO DIA DO MÊS
 *   Pela conta de sete em sete, a quarta cota cairia no dia 28 e sobrariam dois
 *   ou três dias sem exigência nenhuma. O mês tem 30 ou 31 dias, e o aluno tem
 *   até o último deles para fechar o pacote.
 */
function devidoAteAgora(matricula, ate, metaOverride) {
  const meta = metaOverride !== undefined ? Number(metaOverride) : metaDoMes(matricula);
  if (!meta) return 0;
  if (ate >= fimDoMes(ate)) return meta;

  const dia = Number(String(ate).slice(8, 10));
  const cotas = Math.min(Math.floor(dia / 7), SEMANAS_NO_MES - 1);
  // Fração de cota arredonda para baixo: numa conta dividida a fatia pode ser 7,
  // e 7/4 por semana não é inteiro. Cobrar 2 na primeira semana de quem deve
  // 1,75 seria adiantar exigência que o mês ainda vai equilibrar.
  return Math.min(Math.floor((meta * cotas) / SEMANAS_NO_MES), meta);
}

/**
 * Dias que ainda restam no mês, contando hoje.
 *
 * É o teto de check-ins que ainda cabem: `checkins-store` deduplica por dia, e
 * dois treinos na mesma data valem um. Quem deve três com dois dias pela frente
 * não fecha o pacote nem vindo todo dia — e é melhor saber disso hoje, quando
 * ainda dá para conversar sobre o mês que vem, do que no dia 1º.
 */
function diasRestantes(ate) {
  const fim = Number(fimDoMes(ate).slice(8, 10));
  const hoje = Number(String(ate).slice(8, 10));
  return Math.max(fim - hoje + 1, 0);
}

/** Onde vence a próxima cota e quanto ela exige. Null quando o mês já fechou. */
function proximoMarco(matricula, ate, metaOverride) {
  const meta = metaOverride !== undefined ? Number(metaOverride) : metaDoMes(matricula);
  if (!meta || ate >= fimDoMes(ate)) return null;
  const dia = Number(String(ate).slice(8, 10));
  const cotas = Math.min(Math.floor(dia / 7), SEMANAS_NO_MES - 1);

  const proxima = cotas + 1;
  const exigido = Math.min(Math.floor((meta * proxima) / SEMANAS_NO_MES), meta);
  const data = proxima >= SEMANAS_NO_MES
    ? fimDoMes(ate)
    : `${String(ate).slice(0, 8)}${String(proxima * 7).padStart(2, '0')}`;
  return { data, exigido };
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

/* ------------------------- conta compartilhada --------------------------- */

/**
 * Reparte um total inteiro entre pesos, pelo método do maior resto.
 *
 * Proporção pura devolve fração, e check-in não se parte: 12 sobre pesos 3 e 2
 * dá 7,2 e 4,8. Arredondar cada um por conta própria daria 7 e 5 aqui, mas 8 e
 * 5 noutro caso — treze de uma conta que rende doze. O maior resto distribui as
 * sobras uma a uma e fecha exatamente no total.
 */
function repartir(pesos, total) {
  const soma = pesos.reduce((s, p) => s + p, 0);
  if (!soma || !total) return pesos.map(() => 0);

  const exatos = pesos.map((p) => (p * total) / soma);
  const cotas = exatos.map(Math.floor);
  let sobra = total - cotas.reduce((s, x) => s + x, 0);

  // Maior resto primeiro; empate vai para a grade maior, que é quem tem mais
  // aula prevista para usar a vaga.
  const ordem = exatos
    .map((x, i) => ({ i, resto: x - Math.floor(x), peso: pesos[i] }))
    .sort((a, b) => b.resto - a.resto || b.peso - a.peso);

  for (const item of ordem) {
    if (sobra <= 0) break;
    cotas[item.i] += 1;
    sobra -= 1;
  }
  return cotas;
}

/**
 * Distribui as datas da conta entre os participantes, intercalando.
 *
 * Dar os sete primeiros ao titular e os cinco últimos à outra pessoa fecharia a
 * mesma conta no fim do mês, mas no dia 14 um apareceria em dia e o outro
 * zerado — e a régua de marcos existe justamente para cobrar no meio do
 * caminho. Intercalar mantém os dois no mesmo ritmo.
 *
 * A escolha de cada data vai para quem tem o maior crédito acumulado (round
 * robin ponderado): com cotas 7 e 5 a sequência sai A,B,A,A,B,A,B,A,A,B,A,B —
 * proporcional em qualquer ponto do mês, não só no fim.
 */
function intercalar(datas, cotas) {
  const total = cotas.reduce((s, x) => s + x, 0);
  const saida = cotas.map(() => []);
  if (!total) return saida;

  const credito = cotas.map(() => 0);
  const restante = cotas.slice();
  const ordenadas = [...datas].sort();

  for (const data of ordenadas) {
    for (let i = 0; i < cotas.length; i += 1) credito[i] += cotas[i] / total;

    let escolhido = -1;
    for (let i = 0; i < cotas.length; i += 1) {
      if (restante[i] <= 0) continue;
      if (escolhido === -1 || credito[i] > credito[escolhido]) escolhido = i;
    }
    // Todas as cotas cheias: o que passa disso é excedente da conta e não conta
    // para ninguém — o Wellhub não repassa além do teto.
    if (escolhido === -1) break;

    saida[escolhido].push(data);
    credito[escolhido] -= 1;
    restante[escolhido] -= 1;
  }
  return saida;
}

/**
 * Divide uma conta do Wellhub entre o titular e quem treina junto.
 *
 * @param participantes  [titular, ...dependentes] — o titular vem primeiro
 * @param datasDaConta   datas de check-in do Wellhub ID do titular
 * @returns Map matriculaId → { datas, meta, cota, peso }
 */
function repartirConta(participantes, datasDaConta = []) {
  const pesos = participantes.map((m) => grade.diasPorSemana(m));
  const somaSemanal = pesos.reduce((s, p) => s + p, 0);
  // A conta rende no máximo três por semana, some a grade de quantos for: é uma
  // assinatura só, e o teto do repasse é dela, não de cada pessoa.
  const metaConta = Math.min(somaSemanal, TETO_SEMANAL) * SEMANAS_NO_MES;

  const cotas = repartir(pesos, metaConta);
  const fatias = intercalar([...new Set(datasDaConta)], cotas);

  const mapa = new Map();
  participantes.forEach((m, i) => {
    mapa.set(m.id, { datas: fatias[i], meta: cotas[i], cota: cotas[i], peso: pesos[i] });
  });
  return mapa;
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

  // Acumulado do ciclo inteiro. Quando a janela já cobre o mês todo (começo de
  // mês), é o mesmo número — e não custa recalcular.
  const previstasMes = de === primeiroDoMes
    ? previstas
    : aulasPrevistas(matricula, excecoes, { de: primeiroDoMes, ate });
  // Um dia com dois check-ins não vira dois créditos: a grade também conta
  // dias, não aparições.
  const todasDoMes = [...new Set(
    datasFeitas.filter((d) => d >= primeiroDoMes && d <= ate))].sort();

  // O DÉCIMO TERCEIRO CHECK-IN DO MÊS NÃO EXISTE PARA O RELATÓRIO
  //   Nada impede o aluno de passar no portal trinta vezes, e o portal valida
  //   as trinta — mas a assinatura rende doze e o estúdio recebe doze. Contar
  //   as trinta faz o painel prometer receita que não vem, e deixa um único
  //   aluno assíduo esconder três colegas sumidos na soma do mês.
  //
  //   O corte é cronológico: as doze primeiras datas do mês são as que valem,
  //   as demais viram excedente. Fica em `mes.excedente` porque o treino
  //   aconteceu — some daqui e vira bug para quem confere na mão.
  const feitasMes = todasDoMes.slice(0, TETO_MES);
  const excedenteMes = todasDoMes.length - feitasMes.length;

  // A janela de sete dias herda o corte do mês: um treino de ontem que já
  // passou do teto não pode aparecer como crédito da semana.
  const feitas = feitasMes.filter((d) => d >= de && d <= ate);
  const realizado = feitas.length;

  // Conta compartilhada: a meta vem da fatia da conta, não da grade da ficha.
  const metaMes = opcoes.metaMes !== undefined ? Number(opcoes.metaMes) : metaDoMes(matricula);
  const faltamNoMes = Math.max(metaMes - feitasMes.length, 0);
  const devido = devidoAteAgora(matricula, ate, metaMes);
  const saldoRitmo = feitasMes.length - devido;

  // Viabilidade do fechamento: o marco da semana pode estar em dia e o mês já
  // estar perdido na aritmética. Faltando três com dois dias pela frente, não
  // existe cobrança que resolva — o que existe é uma conversa a ter agora.
  const restantes = diasRestantes(ate);
  const risco = !metaMes || !faltamNoMes ? null
    : faltamNoMes > restantes ? 'impossivel'
      : faltamNoMes === restantes ? 'no-limite' : null;

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
      // Check-ins do mês que passaram do teto do repasse: o aluno veio, o
      // portal validou, o estúdio não recebe. Ficam fora de toda régua acima.
      excedente: excedenteMes,
      realizadoBruto: todasDoMes.length,
      teto: TETO_MES,
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
      // Ritmo: o que o pacote já deveria ter rendido até hoje, e onde vence a
      // próxima cota. É daqui que sai a situação do aluno.
      devido,
      saldoRitmo,
      atrasoNoRitmo: Math.max(devido - feitasMes.length, 0),
      proximoMarco: proximoMarco(matricula, ate, metaMes),
      // Conta dividida: quanto da assinatura do titular é desta ficha.
      conta: opcoes.conta || null,
      // `no-limite`: só fecha vindo todos os dias que sobraram.
      // `impossivel`: não fecha mais, faça o que fizer.
      diasRestantes: restantes,
      risco,
    },
    porSemana: grade.diasPorSemana(matricula),
    semGrade: !(matricula.grade || []).length,
    esperado,
    realizado,
    saldo,
    situacao: classificar(saldo, esperado, matricula,
      { metaMes, faltamNoMes, saldoRitmo, risco }),
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

  // QUEM TEM PACOTE É JULGADO PELO RITMO DO MÊS, NÃO PELA JANELA DE SETE DIAS
  //   A janela responde "veio esta semana?"; o pacote responde "vai fechar o
  //   mês?". São perguntas diferentes, e a segunda é a que custa dinheiro: um
  //   aluno pode ter vindo ontem e ainda estar duas cotas atrás, com mais
  //   reposições pendentes do que dias úteis restantes.
  if (mes.metaMes) {
    // A aritmética do fim do mês vence o marco da semana: adianta pouco estar
    // dentro da cota do dia 21 se o que falta já não cabe nos dias que sobraram.
    if (mes.risco === 'impossivel') return 'critico';
    if (mes.risco === 'no-limite' && mes.saldoRitmo >= 0) return 'atrasado';
    if (mes.saldoRitmo >= 0) return 'em-dia';
    return mes.saldoRitmo <= -2 ? 'critico' : 'atrasado';
  }
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
 * Monta a divisão de todas as contas compartilhadas da base.
 *
 * Os check-ins ficam gravados na ficha do titular — é dele o Wellhub ID e é ele
 * quem passa no portal. Aqui a lista dele é repartida entre quem treina na mesma
 * assinatura, e cada um recebe a fatia com a meta correspondente.
 *
 * @returns Map matriculaId → { datas, meta, conta } — só para quem está em grupo
 */
function dividirContas(matriculas, mapaDatas) {
  const fora = new Map();
  const ativos = matriculas.filter((m) => m.ativo);

  const porTitular = new Map();
  for (const m of ativos) {
    if (!m.contaDe) continue;
    if (!porTitular.has(m.contaDe)) porTitular.set(m.contaDe, []);
    porTitular.get(m.contaDe).push(m);
  }

  for (const [titularId, dependentes] of porTitular) {
    const titular = ativos.find((m) => m.id === titularId);
    // Titular inativo ou apagado: os dependentes voltam a ser avaliados
    // sozinhos, o que os deixa devendo — e é justamente o sinal de que a conta
    // precisa ser reapontada.
    if (!titular) continue;

    const participantes = [titular, ...dependentes];
    const repartido = repartirConta(participantes, mapaDatas.get(titularId) || []);

    for (const p of participantes) {
      const r = repartido.get(p.id);
      fora.set(p.id, {
        datas: r.datas,
        meta: r.meta,
        conta: {
          titularId,
          titular: titular.nome,
          ehTitular: p.id === titularId,
          cota: r.cota,
          participantes: participantes.map((x) => x.nome),
        },
      });
    }
  }
  return fora;
}

/**
 * Painel completo. `mapaDatas` é o Map matriculaId → datas de `checkins-store`.
 *
 * Por padrão avalia só quem é Wellhub: mensalista não faz check-in no portal,
 * então o realizado dele seria sempre zero e a lista de atrasados viraria a
 * base inteira. Passe `vinculo: null` para avaliar todo mundo.
 */
function painel(matriculas, mapaDatas, excecoes, opcoes = {}) {
  const vinculo = opcoes.vinculo === undefined ? 'wellhub' : opcoes.vinculo;
  const divisao = dividirContas(matriculas, mapaDatas);

  const lista = matriculas
    .filter((m) => m.ativo && (!vinculo || m.vinculo === vinculo))
    .map((m) => {
      const fatia = divisao.get(m.id);
      // Sem conta compartilhada nada muda: `fatia` é undefined e o aluno é
      // avaliado pela própria grade, como sempre foi.
      return fatia
        ? avaliar(m, fatia.datas, excecoes, { ...opcoes, metaMes: fatia.meta, conta: fatia.conta })
        : avaliar(m, mapaDatas.get(m.id) || [], excecoes, opcoes);
    });

  lista.sort((a, b) =>
    (ORDEM[a.situacao] - ORDEM[b.situacao]) ||
    (a.saldo - b.saldo) ||
    a.nome.localeCompare(b.nome, 'pt-BR'));

  const conta = (s) => lista.filter((x) => x.situacao === s).length;

  // O PACOTE DO MÊS SÓ SOMA QUEM TEM PACOTE
  //   Experimental não tem grade combinada, logo não tem meta — e somar os
  //   check-ins dele no realizado inflava o numerador contra um denominador que
  //   ele não ajudou a formar. Ele é excedente: entra na conta no mês em que
  //   virar aluno de fato, com uma grade e uma meta próprias.
  const doPacote = lista.filter((a) => !a.experimental && a.mes.meta > 0);
  const somar = (f) => doPacote.reduce((s, a) => s + f(a), 0);
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
      comPacote: doPacote.length,
      metaMes: somar((a) => a.mes.meta),
      realizadoMes: somar((a) => a.mes.realizado),
      // Treinos além do teto, somados à parte: é o que o estúdio entrega e não
      // fatura. Nunca entra em `realizadoMes` — aquele número é o do repasse.
      excedenteMes: somar((a) => a.mes.excedente),
      alunosNoTeto: doPacote.filter((a) => a.mes.excedente > 0).length,
      faltamMes: somar((a) => a.mes.faltam),
      devendoNoMes: doPacote.filter((a) => a.mes.faltam > 0).length,
      // Quem já não fecha o pacote: é a conta que o fim do mês vai cobrar.
      naoFecham: doPacote.filter((a) => a.mes.risco === 'impossivel').length,
      noLimite: doPacote.filter((a) => a.mes.risco === 'no-limite').length,
      // Fora do pacote, contado à parte: vira receita prevista quando o aluno
      // sair do experimental e ganhar grade.
      checkinsExperimentais: lista
        .filter((a) => a.experimental).reduce((s, a) => s + a.mes.realizado, 0),
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

/* --------------------------- panorama do mês ----------------------------- */

/**
 * Grade que vale para medir VOLUME numa data passada.
 *
 * `gradeVigente` devolve vazio antes de `vigenteDe`, e faz certo: a tela de um
 * dia passado não pode mostrar o aluno num horário que ainda não era o dele.
 * Só que `vigenteDe` é o dia em que a grade foi digitada na ficha, não o dia em
 * que o aluno começou a treinar. Numa base importada de uma vez os dois são
 * coisas muito diferentes — as 68 fichas Wellhub nasceram todas em 24/08, com
 * check-ins desde o dia 1º, e a projeção ficava colada no zero por 23 dias para
 * depois disparar, como se o estúdio tivesse aberto naquela quarta.
 *
 * Aqui a pergunta é "quanto volume o mês deveria ter", e sem uma grade anterior
 * arquivada não existe horário concorrente a respeitar: a grade de hoje vale
 * para trás. O piso não é o cadastro da ficha, é a estreia — a menor data entre
 * `criadoEm` e o primeiro check-in do aluno no mês. Quem treinou no dia 3 já era
 * aluno no dia 3, por mais que a ficha só tenha sido digitada no 24; e quem
 * entrou de verdade no meio do mês continua sem gerar aula nos dias em que não
 * era aluno de ninguém.
 *
 * @param desde  data de estreia (YYYY-MM-DD) ou null para projetar o mês todo
 */
function gradeParaVolume(matricula, data, desde) {
  const g = grade.gradeVigente(matricula, data);
  if (g.length) return g;
  if (desde && data < desde) return [];
  return matricula.grade || [];
}

/**
 * O mês visto por data, e não por aluno.
 *
 * A aba Frequência responde "quem está devendo". Esta responde "em que dia o
 * previsto e o realizado descolaram" — um feriado, uma semana de chuva ou o
 * portal fora do ar aparecem como um degrau na curva, enquanto a lista por
 * aluno dilui o mesmo buraco em sessenta linhas de -1.
 *
 * SÃO DUAS RÉGUAS, E ELAS MEDEM COISAS DIFERENTES
 *   `meta` é o pacote: combinado semanal x 4, teto 12, porque o Wellhub não
 *   repassa mais do que isso. É o número do fechamento, o que vira dinheiro.
 *   `previsto` é a agenda: a grade projetada sobre o calendário, com as
 *   desmarcações descontadas e as extras somadas. É o número da porta, quanta
 *   gente o estúdio esperava naquele dia.
 *
 *   Elas não batem de propósito. Quem treina segunda, quarta e sexta tem 13
 *   aulas num mês de cinco segundas e só 12 entram no repasse — a agenda é
 *   maior que o pacote. Quem treina de segunda a sexta tem 21 aulas e os
 *   mesmos 12 de teto. Cobrar pela agenda seria cobrar treino que não gera
 *   receita; medir a porta pelo pacote seria fingir que o aluno some depois do
 *   décimo segundo check-in.
 *
 * `metaAcum` É ESCADA, NÃO RAMPA
 *   O combinado é semanal: quem faz 3x precisa ter 3 no dia 7, 6 no dia 14, 9
 *   no dia 21 e os 12 no fechamento. É a mesma régua que decide quem está
 *   atrasado na aba Frequência, então a curva do gráfico e a situação da lista
 *   nunca discordam.
 *
 * UM ALUNO VALE UM CHECK-IN POR DIA
 *   Quem tem dois horários na mesma terça aparece duas vezes na grade e uma vez
 *   só aqui: o Wellhub repassa por dia, e `checkins-store` deduplica igual.
 *
 * EXPERIMENTAL FICA NA PRÓPRIA SÉRIE
 *   Sem grade combinada não há previsto nem meta para comparar. Somado aos
 *   alunos, o treino dele empurraria o realizado acima do previsto num dia em
 *   que ninguém do pacote veio a mais.
 *
 * O DIA DE HOJE MOSTRA O DIA INTEIRO
 *   `aulasPrevistas` corta as aulas cujo horário ainda não passou, porque lá o
 *   número vira cobrança. Aqui não: uma coluna de hoje que cresce ao longo do
 *   dia faria o gráfico mudar de forma a cada visita.
 */
function panoramaDoMes({ matriculas = [], excecoes = [], checkins = [], mes } = {}) {
  const hoje = hojeLocal();
  const base = /^\d{4}-\d{2}$/.test(String(mes || '')) ? `${mes}-01` : hoje;
  const de = inicioDoMes(base);
  const fim = fimDoMes(base);

  const porId = new Map(matriculas.map((m) => [m.id, m]));
  // Só quem faz check-in e tem pacote: mensalista não passa pelo portal e
  // experimental ainda não combinou grade nenhuma.
  const comPacote = matriculas.filter((m) =>
    (m.vinculo || 'mensalista') === 'wellhub' && !m.experimental);
  const naGrade = comPacote.filter((m) => m.ativo);
  const idsNaGrade = new Set(naGrade.map((m) => m.id));
  const metas = new Map(comPacote.map((m) => [m.id, metaDoMes(m)]));

  // Primeiro check-in de cada aluno no mês: a evidência de quando ele já estava
  // treinando, que numa base importada chega muito antes do cadastro da ficha.
  const primeiro = new Map();
  for (const c of checkins) {
    if (!c.matriculaId || c.data < de || c.data > fim) continue;
    const atual = primeiro.get(c.matriculaId);
    if (!atual || c.data < atual) primeiro.set(c.matriculaId, c.data);
  }
  // Estreia de cada ficha, resolvida uma vez só — dentro do laço de dias isto
  // seria a mesma conta trinta e uma vezes por aluno.
  const estreia = new Map(naGrade.map((m) => {
    const cadastro = String(m.criadoEm || '').slice(0, 10) || null;
    const treinou = primeiro.get(m.id) || null;
    if (!cadastro) return [m.id, treinou];
    if (!treinou) return [m.id, cadastro];
    return [m.id, treinou < cadastro ? treinou : cadastro];
  }));

  const dias = [];
  const indice = new Map();
  for (let d = de; d <= fim; d = grade.somarDias(d, 1)) {
    const linha = {
      data: d,
      dia: Number(d.slice(8, 10)),
      diaDaSemana: grade.diaDaSemana(d),
      previsto: 0,
      feito: 0,
      // Check-ins de aluno que já passaram do teto do mês. Série própria: são
      // reais, e somados ao `feito` empurrariam a curva do repasse para cima.
      fora: 0,
      experimental: 0,
      semVinculo: 0,
      futuro: d > hoje,
      ehHoje: d === hoje,
    };
    dias.push(linha);
    indice.set(d, linha);
  }

  // Previsto do dia: a grade projetada, contada por pessoa e não por aula.
  for (const linha of dias) {
    const doDia = excecoes.filter((e) => e.data === linha.data);
    const cancelou = (id, hora) => doDia.some((e) =>
      e.tipo === 'cancelou' && e.matriculaId === id && (!e.hora || e.hora === hora));

    const pessoas = new Set();
    for (const m of naGrade) {
      for (const s of gradeParaVolume(m, linha.data, estreia.get(m.id))) {
        if (s.dia !== linha.diaDaSemana || cancelou(m.id, s.hora)) continue;
        pessoas.add(m.id);
        break;
      }
    }
    for (const e of doDia) {
      if (e.tipo !== 'extra' || !e.hora) continue;
      if (!idsNaGrade.has(e.matriculaId)) continue;
      if (cancelou(e.matriculaId, e.hora)) continue;
      pessoas.add(e.matriculaId);
    }
    linha.previsto = pessoas.size;

    // Meta acumulada até esta data — a mesma escada de marcos que a aba
    // Frequência usa para dizer quem está atrasado.
    linha.metaAcum = comPacote.reduce((s, m) =>
      s + devidoAteAgora(m, linha.data, metas.get(m.id)), 0);
  }

  // Realizado: deduplicado por pessoa e dia, do mesmo jeito que o repasse. Sem
  // ficha, a chave é a conta do portal — dois check-ins do mesmo órfão no mesmo
  // dia continuam sendo um.
  //
  // O TETO DO REPASSE VALE AQUI TAMBÉM
  //   `metaAcum` soma doze por aluno; se o realizado somasse os trinta que uma
  //   pessoa muito assídua faz, a curva amarela passaria a tracejada num mês em
  //   que metade do estúdio sumiu. Do décimo terceiro em diante o check-in vai
  //   para `fora` — a linha do treino que o estúdio dá e não fatura.
  //
  //   A ordem importa: o corte é "as doze primeiras do mês", e `listar` devolve
  //   do mais recente para o mais antigo. Sem ordenar, o dia 28 entraria no
  //   pacote e o dia 2 viraria excedente.
  const emOrdem = [...checkins].sort((a, b) =>
    String(a.data).localeCompare(String(b.data)));

  const vistos = new Set();
  const noMes = new Map();
  for (const c of emOrdem) {
    const linha = indice.get(c.data);
    if (!linha) continue;
    const chave = c.matriculaId
      ? `m:${c.matriculaId}|${c.data}`
      : `g:${c.gympassId || c.id}|${c.data}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);

    if (!c.matriculaId) { linha.semVinculo += 1; continue; }
    const m = porId.get(c.matriculaId);
    if (m && m.experimental) { linha.experimental += 1; continue; }

    const n = (noMes.get(c.matriculaId) || 0) + 1;
    noMes.set(c.matriculaId, n);
    if (n > TETO_MES) linha.fora += 1;
    else linha.feito += 1;
  }

  // Acumulados: a leitura do mês é de soma corrida, não de coluna solta. Sai
  // daqui e não da tela para o CSV exportar exatamente o que o gráfico desenha.
  let aPrevisto = 0; let aFeito = 0; let aExp = 0; let aSem = 0; let aFora = 0;
  for (const l of dias) {
    aPrevisto += l.previsto; aFeito += l.feito;
    aExp += l.experimental; aSem += l.semVinculo; aFora += l.fora;
    l.previstoAcum = aPrevisto;
    l.feitoAcum = aFeito;
    l.foraAcum = aFora;
    l.experimentalAcum = aExp;
    l.semVinculoAcum = aSem;
  }

  const ateHoje = dias.filter((l) => !l.futuro);
  const ultimoFechado = ateHoje.length ? ateHoje[ateHoje.length - 1] : null;

  return {
    mes: de.slice(0, 7),
    de,
    ate: fim,
    hoje,
    metaMes: comPacote.reduce((s, m) => s + metas.get(m.id), 0),
    alunosComPacote: comPacote.length,
    dias,
    totais: {
      previsto: aPrevisto,
      // O previsto que já venceu. Comparar o feito com o mês inteiro no dia 5
      // diria que o estúdio está 90% vazio.
      previstoAteHoje: ateHoje.reduce((s, l) => s + l.previsto, 0),
      metaAteHoje: ultimoFechado ? ultimoFechado.metaAcum : 0,
      feito: aFeito,
      // Treino entregue acima do teto: não entra em `feito` nem na meta.
      fora: aFora,
      alunosNoTeto: [...noMes.values()].filter((n) => n > TETO_MES).length,
      experimental: aExp,
      semVinculo: aSem,
    },
  };
}

module.exports = {
  avaliar, painel, devedores, aulasPrevistas, metaDoMes, devidoAteAgora, proximoMarco,
  diasRestantes, repartirConta, dividirContas, repartir, intercalar, panoramaDoMes,
  hojeLocal, agoraEmMinutos, inicioDoMes, fimDoMes,
  TOLERANCIA_MIN, SEMANAS_NO_MES, TETO_SEMANAL, TETO_MES,
};
