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
 *
 * SÃO TRÊS FAIXAS, NÃO DUAS
 *   Até a meta é PACOTE: o combinado, o que o mês tinha de render e o que a
 *   cobrança usa. Da meta até doze é EXCEDENTE: o aluno veio a mais, o Wellhub
 *   paga, mas não era previsto e não entra na régua de quem está atrasado.
 *   Acima de doze é IGNORADO: aconteceu e não rende nada.
 *
 *   Quem tem meta doze não tem faixa do meio — para ele o teto e o pacote são
 *   o mesmo número. Quem tem meta oito tem quatro check-ins de excedente
 *   possíveis antes de começar a desperdiçar.
 */
const TETO_MES = Number(process.env.FREQ_TETO_MES || TETO_SEMANAL * SEMANAS_NO_MES);

/* ------------------------------ financeiro -------------------------------- *
 * O Wellhub paga por check-in validado, e o valor muda com o produto que o
 * aluno marcou. Contar treinos responde "quem está devendo"; multiplicar pelo
 * preço responde "quanto o mês vale", que é outra pergunta e mora aqui.
 * -------------------------------------------------------------------------- */

/**
 * Produto do portal reduzido a uma chave estável.
 *
 * Hoje o portal escreve "Funcional" e "Crosstraining", mas já variou de caixa e
 * de acento; comparar o texto cru faria o preço sumir no dia em que virasse
 * "Cross Training". O que não for reconhecido devolve null e a tela mostra
 * quantos ficaram sem preço, em vez de somar um número inventado.
 */
function chaveProduto(produto) {
  const t = String(produto || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (!t) return null;
  if (t.includes('funcional')) return 'funcional';
  if (t.includes('cross')) return 'crosstraining';
  return null;
}

/** Só valem enquanto Configurações → Negócio não for preenchido. */
const PRECOS_PADRAO = { funcional: 18.75, crosstraining: 22.28 };

/**
 * Tabela em CENTAVOS.
 *
 * Somar 22,28 em ponto flutuante quatrocentas vezes devolve um total com resto
 * de fração de centavo, e o número que aparece na tela é o que a pessoa vai
 * comparar com o extrato. Inteiro não erra; a divisão por cem acontece uma vez
 * só, na saída.
 */
function tabelaDePrecos(precos = {}) {
  const cent = (valor, padrao) => {
    const n = Number(valor);
    return Math.round((Number.isFinite(n) && n >= 0 ? n : padrao) * 100);
  };
  const tabela = {
    funcional: cent(precos.valorFuncional, PRECOS_PADRAO.funcional),
    crosstraining: cent(precos.valorCrosstraining, PRECOS_PADRAO.crosstraining),
  };
  // Produto desconhecido vale o menor dos dois: numa previsão que vira decisão
  // de caixa, errar para baixo custa menos do que prometer o que não entra.
  tabela.padrao = Math.min(tabela.funcional, tabela.crosstraining);
  return tabela;
}

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
 * QUANTO O ALUNO JÁ DEVERIA TER FEITO A ESTA ALTURA DO MÊS
 *
 * A régua é linear: a meta do mês repartida pelos dias do mês, acumulada dia a
 * dia. No dia 27 de um mês de 31, quem combinou 12 já deveria ter 10.
 *
 * POR QUE NÃO A ESCADA SEMANAL
 *   A versão anterior subia em degraus nos dias 7, 14, 21 e no fechamento,
 *   seguindo o desenho do pacote — que é vendido por semana. O problema é o que
 *   acontece ENTRE dois degraus: no dia 27 a régua ainda cobrava o que era
 *   exigido no dia 21, ignorando seis dias de treino que aconteceram e seis
 *   dias de aula que foram cobrados. Quem sumiu depois do dia 21 continuava
 *   "em dia" até o dia 28, e a curva do gráfico dava saltos que não
 *   correspondiam a nada no calendário.
 *
 *   O pacote continua semanal na venda; só a medição do ritmo virou diária.
 *   `metaDoMes` não mudou — o que se cobra no fim do mês é o mesmo número.
 */
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
  const diasDoMes = Number(fimDoMes(ate).slice(8, 10));
  // Fração arredonda para baixo: check-in é inteiro, e cobrar 11 de quem deve
  // 10,45 seria exigir hoje o treino de amanhã.
  return Math.min(Math.floor((meta * dia) / diasDoMes), meta);
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

/**
 * Quando a régua sobe mais um treino, e para quanto. Null com o mês fechado.
 *
 * A conta é a inversa de `devidoAteAgora`: o menor dia em que a linha linear
 * alcança o próximo inteiro. Meta 12 num mês de 31 dias exige o 11º a partir
 * do dia 29, porque 12 × 29 ÷ 31 = 11,2.
 */
function proximoMarco(matricula, ate, metaOverride) {
  const meta = metaOverride !== undefined ? Number(metaOverride) : metaDoMes(matricula);
  if (!meta || ate >= fimDoMes(ate)) return null;

  const diasDoMes = Number(fimDoMes(ate).slice(8, 10));
  const exigido = Math.min(devidoAteAgora(matricula, ate, meta) + 1, meta);
  const diaAlvo = Math.min(Math.ceil((exigido * diasDoMes) / meta), diasDoMes);
  return {
    data: `${String(ate).slice(0, 8)}${String(diaAlvo).padStart(2, '0')}`,
    exigido,
  };
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

  // Conta compartilhada: a meta vem da fatia da conta, não da grade da ficha.
  const metaMes = opcoes.metaMes !== undefined ? Number(opcoes.metaMes) : metaDoMes(matricula);

  // O QUE O ALUNO PROMETEU, O QUE AINDA RENDE E O QUE SE PERDE
  //   Nada impede o aluno de passar no portal trinta vezes, e o portal valida
  //   as trinta. Mas quem combinou oito rende oito de pacote; do nono ao
  //   décimo segundo o Wellhub ainda paga, só que aquilo não era previsto por
  //   ninguém; e do décimo terceiro em diante não entra nada.
  //
  //   Contar tudo junto faz o painel prometer receita que não vem e deixa um
  //   aluno assíduo esconder três colegas sumidos na soma do mês. Por isso as
  //   três faixas: `realizado` é o pacote, `excedente` é o que veio a mais e
  //   ainda rende, `ignorado` é o que passou do teto da assinatura.
  //
  //   O corte é cronológico — as primeiras datas do mês, em ordem, preenchem o
  //   pacote. Nada some da base: `checkins-store` guarda os trinta.
  //
  //   SEM GRADE NÃO HÁ PACOTE A COMPARAR
  //     Ficha nova, ainda sem horários combinados, tem meta zero. Aí não existe
  //     faixa do meio para calcular: o teto do repasse vira o pacote inteiro,
  //     que é como esta tela sempre tratou esse caso.
  const tetoPacote = metaMes > 0 ? Math.min(metaMes, TETO_MES) : TETO_MES;
  const feitasMes = todasDoMes.slice(0, tetoPacote);
  const pagasMes = todasDoMes.slice(0, TETO_MES);
  const excedenteMes = pagasMes.length - feitasMes.length;
  const ignoradoMes = todasDoMes.length - pagasMes.length;

  // A janela de sete dias herda o corte do pacote: um treino de ontem que já
  // passou do combinado não pode aparecer como crédito da semana.
  const feitas = feitasMes.filter((d) => d >= de && d <= ate);
  const realizado = feitas.length;

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
      // Treino além do combinado que o Wellhub ainda paga: da meta até o teto
      // de doze. Não entra em `realizado` — não era previsto, e somá-lo faria
      // um aluno de meta oito aparecer com 12/8 no fechamento.
      excedente: excedenteMes,
      // Passou do teto da assinatura: aconteceu e não rende nada.
      ignorado: ignoradoMes,
      // O que de fato vira repasse: pacote + excedente, nunca mais que o teto.
      contabilizavel: feitasMes.length + excedenteMes,
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
      // Além do combinado, somado à parte: o Wellhub paga, mas não era previsto
      // e não pode inflar `realizadoMes`, que é a régua do pacote.
      excedenteMes: somar((a) => a.mes.excedente),
      // Repasse esperado do mês: pacote + excedente.
      contabilizavelMes: somar((a) => a.mes.contabilizavel),
      // O que o estúdio entrega e não fatura: passou dos doze.
      ignoradosMes: somar((a) => a.mes.ignorado),
      alunosComExcedente: doPacote.filter((a) => a.mes.excedente > 0).length,
      alunosNoTeto: doPacote.filter((a) => a.mes.ignorado > 0).length,
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
function panoramaDoMes({
  matriculas = [], excecoes = [], checkins = [], mes,
  // Configurações → Negócio. Ausente, cai nos padrões da tabela.
  precos = {},
  // matriculaId → produto do último check-in, de `checkins-store`. Serve só
  // para precificar o que ainda vai acontecer.
  produtos = new Map(),
} = {}) {
  const tabela = tabelaDePrecos(precos);
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

  // A SALA INTEIRA, PARA A CONTA DE OCUPAÇÃO
  //   Tudo acima é sobre repasse, e nisso mensalista não entra: ele não passa
  //   pelo portal e não gera check-in. Só que "quanta gente eu espero na porta"
  //   não é uma pergunta de repasse — é de sala cheia e de professor na
  //   escala —, e responder 68 quando 121 pessoas têm horário fixo subestima a
  //   ocupação pela metade.
  //
  //   Esta população não toca nas linhas do gráfico nem no dinheiro: só produz
  //   o total da agenda, ao lado do recorte Wellhub.
  const naAgenda = matriculas.filter((m) => m.ativo && (m.grade || []).length);
  const idsNaAgenda = new Set(naAgenda.map((m) => m.id));

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
  const estreia = new Map(naAgenda.concat(
    naGrade.filter((m) => !idsNaAgenda.has(m.id)),
  ).map((m) => {
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
      // Mesma projeção, população inteira do estúdio (Wellhub + mensalista).
      // Fica fora do gráfico: é ocupação, não repasse.
      previstoTodos: 0,
      feito: 0,
      // Treino além do combinado do aluno, mas dentro dos doze que a assinatura
      // paga. Série própria: somado ao `feito` empurraria a curva do pacote
      // acima da meta num mês em que metade do estúdio sumiu.
      fora: 0,
      // Passou dos doze: aconteceu e não rende. Não vira linha no gráfico,
      // só número — é a conta do que o estúdio entrega de graça.
      ignorado: 0,
      experimental: 0,
      semVinculo: 0,
      // Em centavos até o fim da função; vira reais junto com o acumulado.
      receitaCent: 0,
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

    const todos = new Set();
    for (const m of naAgenda) {
      for (const s of gradeParaVolume(m, linha.data, estreia.get(m.id))) {
        if (s.dia !== linha.diaDaSemana || cancelou(m.id, s.hora)) continue;
        todos.add(m.id);
        break;
      }
    }
    for (const e of doDia) {
      if (e.tipo !== 'extra' || !e.hora) continue;
      if (!idsNaAgenda.has(e.matriculaId)) continue;
      if (cancelou(e.matriculaId, e.hora)) continue;
      todos.add(e.matriculaId);
    }
    // Wellhub ativo sem grade cadastrada não entra em `naAgenda`, mas pode ter
    // aula extra e já estar somado em `previsto`. Sem esta união o total do
    // estúdio sairia menor que o recorte Wellhub, que é impossível.
    for (const id of pessoas) todos.add(id);
    linha.previstoTodos = todos.size;

    // Meta acumulada até esta data — a mesma régua que a aba Frequência usa
    // para dizer quem está atrasado, somada aluno a aluno.
    linha.metaAcum = comPacote.reduce((s, m) =>
      s + devidoAteAgora(m, linha.data, metas.get(m.id)), 0);

    // A MESMA RÉGUA, SEM O ARREDONDAMENTO — SÓ PARA DESENHAR
    //   `devidoAteAgora` arredonda para baixo porque check-in é inteiro: não se
    //   cobra 10,45 treinos de ninguém. Só que as metas do estúdio são poucas e
    //   repetidas (4, 8 e 12), então todo mundo cruza o inteiro no mesmo dia e a
    //   soma volta a dar saltos de dezenas — o degrau semanal trocado por um
    //   degrau de três em três dias.
    //
    //   Para a linha do gráfico a fração serve melhor: ela responde "a esta
    //   altura do mês, quanto o estúdio inteiro deveria ter", e aí meio treino
    //   de cada um soma um número perfeitamente real. O tooltip e o CSV seguem
    //   mostrando o inteiro, que é o que se cobra de uma pessoa.
    const diasDoMes = Number(fim.slice(8, 10));
    const passado = Math.min(Number(linha.data.slice(8, 10)), diasDoMes);
    linha.metaExata = Math.round(comPacote.reduce((s, m) =>
      s + ((metas.get(m.id) || 0) * passado) / diasDoMes, 0) * 10) / 10;
  }

  // Realizado: deduplicado por pessoa e dia, do mesmo jeito que o repasse. Sem
  // ficha, a chave é a conta do portal — dois check-ins do mesmo órfão no mesmo
  // dia continuam sendo um.
  //
  // AS MESMAS TRÊS FAIXAS DA ABA FREQUÊNCIA
  //   `metaAcum` soma o combinado de cada aluno. Se o realizado somasse os
  //   trinta que uma pessoa muito assídua faz, a curva amarela passaria a
  //   tracejada num mês em que metade do estúdio sumiu. Então cada check-in
  //   entra na faixa a que pertence: até a meta do aluno é pacote (`feito`),
  //   da meta até doze é excedente pago (`fora`), acima disso é `ignorado`.
  //
  //   Sem meta — ficha sem grade, mensalista com check-in avulso — o teto do
  //   repasse serve de pacote, que é como esta tela sempre contou.
  //
  //   A ordem importa: o corte é "as primeiras do mês", e `listar` devolve do
  //   mais recente para o mais antigo. Sem ordenar, o dia 28 entraria no pacote
  //   e o dia 2 viraria excedente.
  const emOrdem = [...checkins].sort((a, b) =>
    String(a.data).localeCompare(String(b.data)));

  const vistos = new Set();
  const noMes = new Map();
  // Teto do repasse contado por PESSOA, não por faixa: os doze são da
  // assinatura e valem igual para o aluno de pacote, para o experimental e
  // para quem ainda não tem ficha. Reusar `noMes` deixaria justamente os dois
  // últimos — o que a tela chama de "extra" — sem teto nenhum.
  const pagos = new Map();
  const treinouHoje = new Set();
  const receita = {
    pacoteCent: 0, excedenteCent: 0, experimentalCent: 0,
    semVinculoCent: 0, perdidoCent: 0,
  };
  const porProduto = {
    funcional: { checkins: 0, cent: 0 },
    crosstraining: { checkins: 0, cent: 0 },
    semProduto: { checkins: 0, cent: 0 },
  };

  /* ------------------ o check-in que vale menos à toa --------------------- *
   * Funcional e crosstraining custam o mesmo para o aluno: são o mesmo plano
   * do lado dele. Do lado do estúdio, um paga menos que o outro. Quem entra
   * pelo produto barato não economiza nada e o estúdio deixa a diferença na
   * mesa — é a única perda desta tela que se resolve com uma conversa, e não
   * com o aluno treinando mais.
   *
   * Só entram os check-ins que RENDEM: acima dos doze do teto a diferença é
   * zero contra zero, e somá-la inventaria dinheiro que não existia.
   *
   * Se um dia o funcional passar a pagar mais, `diferenca` fica negativa e a
   * conta se desliga sozinha — não há o que instruir.
   * ---------------------------------------------------------------------- */
  const diferencaCent = tabela.crosstraining - tabela.funcional;
  const noBarato = new Map();
  // Quantos check-ins do mês o Wellhub de fato paga, somando todas as faixas —
  // pacote, excedente, experimental e órfão. É o número que casa com o extrato,
  // e o único da tela que dá para conferir linha a linha lá.
  let checkinsPagos = 0;
  let checkinsNaoPagos = 0;

  for (const c of emOrdem) {
    const linha = indice.get(c.data);
    if (!linha) continue;
    const chave = c.matriculaId
      ? `m:${c.matriculaId}|${c.data}`
      : `g:${c.gympassId || c.id}|${c.data}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);

    const chaveFin = c.matriculaId ? `m:${c.matriculaId}` : `g:${c.gympassId || c.id}`;
    const nPago = (pagos.get(chaveFin) || 0) + 1;
    pagos.set(chaveFin, nPago);
    if (c.matriculaId && c.data === hoje) treinouHoje.add(c.matriculaId);

    const kProduto = chaveProduto(c.produto);
    const valor = kProduto ? tabela[kProduto] : tabela.padrao;
    const rende = nPago <= TETO_MES;

    const doProduto = porProduto[kProduto || 'semProduto'];
    doProduto.checkins += 1;
    if (rende) { doProduto.cent += valor; linha.receitaCent += valor; checkinsPagos += 1; }
    else { receita.perdidoCent += valor; checkinsNaoPagos += 1; }

    if (rende && diferencaCent > 0 && kProduto === 'funcional') {
      const jaTem = noBarato.get(chaveFin) || {
        matriculaId: c.matriculaId || null,
        // Sem ficha o nome do portal é tudo que existe — e é o suficiente para
        // achar a pessoa na aba Frequência e vincular.
        nome: c.nomeMatricula || c.nome || 'Sem nome',
        semFicha: !c.matriculaId,
        checkins: 0,
        cent: 0,
      };
      jaTem.checkins += 1;
      jaTem.cent += diferencaCent;
      noBarato.set(chaveFin, jaTem);
    }

    if (!c.matriculaId) {
      linha.semVinculo += 1;
      if (rende) receita.semVinculoCent += valor;
      continue;
    }
    const m = porId.get(c.matriculaId);
    if (m && m.experimental) {
      linha.experimental += 1;
      if (rende) receita.experimentalCent += valor;
      continue;
    }

    const meta = metas.get(c.matriculaId) || 0;
    const tetoPacote = meta > 0 ? Math.min(meta, TETO_MES) : TETO_MES;
    const n = (noMes.get(c.matriculaId) || 0) + 1;
    noMes.set(c.matriculaId, n);
    if (n <= tetoPacote) { linha.feito += 1; receita.pacoteCent += valor; }
    else if (n <= TETO_MES) { linha.fora += 1; receita.excedenteCent += valor; }
    else linha.ignorado += 1;
  }

  // Acumulados: a leitura do mês é de soma corrida, não de coluna solta. Sai
  // daqui e não da tela para o CSV exportar exatamente o que o gráfico desenha.
  let aPrevisto = 0; let aFeito = 0; let aExp = 0; let aSem = 0;
  let aFora = 0; let aIgn = 0; let aReceita = 0; let aTodos = 0;
  for (const l of dias) {
    aPrevisto += l.previsto; aFeito += l.feito;
    aExp += l.experimental; aSem += l.semVinculo;
    aFora += l.fora; aIgn += l.ignorado;
    aTodos += l.previstoTodos;
    l.previstoTodosAcum = aTodos;
    aReceita += l.receitaCent;
    l.receita = l.receitaCent / 100;
    l.receitaAcum = aReceita / 100;
    delete l.receitaCent;
    l.previstoAcum = aPrevisto;
    l.feitoAcum = aFeito;
    l.foraAcum = aFora;
    l.ignoradoAcum = aIgn;
    l.experimentalAcum = aExp;
    l.semVinculoAcum = aSem;
  }

  const ateHoje = dias.filter((l) => !l.futuro);
  const ultimoFechado = ateHoje.length ? ateHoje[ateHoje.length - 1] : null;

  /* --------------------- o que ainda pode entrar --------------------------- *
   * SÓ O PACOTE ENTRA NA PREVISÃO
   *   Excedente e experimental são o aluno decidindo aparecer; colocá-los na
   *   projeção é contar no caixa com o que ninguém combinou. O que se promete
   *   é o combinado: cada aluno projeta o que falta para a meta dele.
   *
   * O LIMITE É O CALENDÁRIO
   *   `checkins-store` deduplica por dia, então ninguém gera dois repasses na
   *   mesma data. Quem deve cinco com três dias pela frente rende três, não
   *   cinco — e quem já treinou hoje não pode contar o dia de hoje de novo.
   *
   * MÊS PASSADO NÃO TEM PREVISÃO
   *   Ali o que houve é tudo o que vai haver; a tela mostra o realizado e
   *   pronto.
   * ------------------------------------------------------------------------ */
  const mesCorrente = de.slice(0, 7) === hoje.slice(0, 7);
  const restantesDoMes = mesCorrente ? diasRestantes(hoje) : 0;
  let aReceberCent = 0;
  let aRecuperarCent = 0;
  let projetados = 0;
  let alunosNaProjecao = 0;
  if (restantesDoMes > 0) {
    for (const m of naGrade) {
      const meta = metas.get(m.id) || 0;
      if (!meta) continue;
      const tetoPacote = Math.min(meta, TETO_MES);
      const feitosPacote = Math.min(noMes.get(m.id) || 0, tetoPacote);
      const cabem = treinouHoje.has(m.id) ? restantesDoMes - 1 : restantesDoMes;
      const faltam = Math.min(Math.max(meta - feitosPacote, 0), Math.max(cabem, 0));
      if (!faltam) continue;
      const k = chaveProduto(produtos.get(m.id));
      aReceberCent += faltam * (k ? tabela[k] : tabela.padrao);
      // O que ainda dá para virar: instruir hoje muda o preço dos treinos que
      // faltam, não o dos que já passaram.
      if (k === 'funcional' && diferencaCent > 0) aRecuperarCent += faltam * diferencaCent;
      projetados += faltam;
      alunosNaProjecao += 1;
    }
  }

  const recebidoCent = receita.pacoteCent + receita.excedenteCent
    + receita.experimentalCent + receita.semVinculoCent;
  const reais = (cent) => cent / 100;

  return {
    mes: de.slice(0, 7),
    de,
    ate: fim,
    hoje,
    metaMes: comPacote.reduce((s, m) => s + metas.get(m.id), 0),
    alunosComPacote: comPacote.length,
    alunosNaAgenda: naAgenda.length,
    alunosNaAgendaWellhub: naGrade.length,
    /**
     * Fichas cuja agenda começa tarde no mês SÓ porque a ficha foi cadastrada
     * tarde — sem nenhum check-in que prove o contrário.
     *
     * Quem passa pelo portal não cai aqui: o primeiro check-in do mês puxa a
     * estreia para trás mesmo numa ficha digitada no dia 24. Mensalista não
     * deixa essa marca, e numa base importada de uma vez a estreia dele vira a
     * data da importação — a agenda sai honestamente baixa, e sem esta contagem
     * a tela deixaria parecer que mensalista não treina.
     *
     * Não filtra por vínculo de propósito: o que define o caso é a falta de
     * evidência, e um aluno Wellhub que não treinou o mês todo tem o mesmo
     * problema.
     */
    agendaParcial: (() => {
      const semProva = naAgenda.filter((m) =>
        !primeiro.has(m.id) && (estreia.get(m.id) || de) > de);
      return {
        pessoas: semProva.length,
        // A partir de quando a agenda desse grupo passa a contar.
        desde: semProva.reduce((menor, m) => {
          const d = estreia.get(m.id);
          return !menor || d < menor ? d : menor;
        }, null),
      };
    })(),
    dias,
    totais: {
      previsto: aPrevisto,
      // Agenda do estúdio inteiro e a parte que não é Wellhub. Ocupação, não
      // repasse: nenhum dos dois entra nas contas de dinheiro.
      previstoTodos: aTodos,
      previstoOutros: aTodos - aPrevisto,
      // O previsto que já venceu. Comparar o feito com o mês inteiro no dia 5
      // diria que o estúdio está 90% vazio.
      previstoAteHoje: ateHoje.reduce((s, l) => s + l.previsto, 0),
      metaAteHoje: ultimoFechado ? ultimoFechado.metaAcum : 0,
      feito: aFeito,
      // Além do combinado e dentro dos doze: o Wellhub paga, a meta não previa.
      fora: aFora,
      // Repasse esperado do mês: pacote + excedente.
      contabilizavel: aFeito + aFora,
      // Passou dos doze: entregue e não faturado.
      ignorado: aIgn,
      alunosNoTeto: [...noMes.values()].filter((n) => n > TETO_MES).length,
      experimental: aExp,
      semVinculo: aSem,
      receita: reais(recebidoCent),
    },
    /**
     * O mês em dinheiro. `realizado` é o que já foi validado e rende;
     * `aReceber` é o que o pacote ainda promete até o dia 31; `previsto` é a
     * soma dos dois — o número que responde "quanto devo receber neste mês".
     */
    financeiro: {
      moeda: 'BRL',
      // Em check-ins, não em reais: é a ponte entre os cartões de contagem lá
      // em cima e o dinheiro daqui de baixo.
      checkins: { pagos: checkinsPagos, naoPagos: checkinsNaoPagos },
      precos: {
        funcional: reais(tabela.funcional),
        crosstraining: reais(tabela.crosstraining),
      },
      realizado: {
        pacote: reais(receita.pacoteCent),
        excedente: reais(receita.excedenteCent),
        experimental: reais(receita.experimentalCent),
        semVinculo: reais(receita.semVinculoCent),
        total: reais(recebidoCent),
      },
      // Passou dos doze por pessoa: o treino aconteceu e o repasse não vem.
      perdido: reais(receita.perdidoCent),
      aReceber: reais(aReceberCent),
      previsto: reais(recebidoCent + aReceberCent),
      projetados,
      alunosNaProjecao,
      diasRestantes: restantesDoMes,
      mesCorrente,
      porProduto: {
        funcional: {
          checkins: porProduto.funcional.checkins,
          valor: reais(porProduto.funcional.cent),
        },
        crosstraining: {
          checkins: porProduto.crosstraining.checkins,
          valor: reais(porProduto.crosstraining.cent),
        },
        // Produto que o portal mandou com outro nome: entrou pelo valor mais
        // baixo e precisa aparecer, senão vira erro silencioso na conta.
        semProduto: {
          checkins: porProduto.semProduto.checkins,
          valor: reais(porProduto.semProduto.cent),
        },
      },
      /**
       * A perda que se resolve conversando: quem marca funcional podendo marcar
       * crosstraining pelo mesmo preço.
       *
       * `deixadoNaMesa` já aconteceu neste mês e não volta. `aRecuperar` é o
       * que os treinos que ainda faltam rendem a mais se a pessoa for
       * instruída hoje — é este o número que justifica a ligação.
       */
      trocaDeProduto: {
        diferenca: reais(diferencaCent),
        checkins: [...noBarato.values()].reduce((s, a) => s + a.checkins, 0),
        pessoas: noBarato.size,
        deixadoNaMesa: reais([...noBarato.values()].reduce((s, a) => s + a.cent, 0)),
        aRecuperar: reais(aRecuperarCent),
        // Do maior para o menor: a lista existe para ser percorrida de cima
        // para baixo até o esforço deixar de valer a pena.
        alunos: [...noBarato.values()]
          .map((a) => ({
            matriculaId: a.matriculaId,
            nome: a.nome,
            semFicha: a.semFicha,
            checkins: a.checkins,
            deixadoNaMesa: reais(a.cent),
          }))
          .sort((a, b) => b.deixadoNaMesa - a.deixadoNaMesa
            || a.nome.localeCompare(b.nome, 'pt-BR')),
      },
    },
  };
}

module.exports = {
  avaliar, painel, devedores, aulasPrevistas, metaDoMes, devidoAteAgora, proximoMarco,
  diasRestantes, repartirConta, dividirContas, repartir, intercalar, panoramaDoMes,
  hojeLocal, agoraEmMinutos, inicioDoMes, fimDoMes,
  TOLERANCIA_MIN, SEMANAS_NO_MES, TETO_SEMANAL, TETO_MES,
};
