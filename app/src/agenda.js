'use strict';

const config = require('./config');
const store = require('./agenda-store');
const matriculas = require('./matriculas-store');
const grade = require('./grade');
// Só a Lista do dia usa. `presencas` não depende deste arquivo, então não há
// ciclo de require.
const presencas = require('./presencas');

const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
const NOME_DO_DIA = {
  dom: 'Domingo', seg: 'Segunda', ter: 'Terça', qua: 'Quarta',
  qui: 'Quinta', sex: 'Sexta', sab: 'Sábado',
};

/* --------------------------- data e hora --------------------------------- */
// Tudo é comparado em termos locais do estúdio, sem conta de fuso.

function hoje(fuso) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function agoraEmMinutos(fuso) {
  const [h, m] = new Intl.DateTimeFormat('en-GB', {
    timeZone: fuso, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date()).split(':');
  return Number(h) * 60 + Number(m);
}

function emMinutos(hora) {
  const [h, m] = String(hora).split(':');
  return Number(h) * 60 + Number(m || 0);
}

function somarDias(data, n) {
  const d = new Date(`${data}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function diferencaEmDias(de, para) {
  return Math.round((new Date(`${para}T12:00:00Z`) - new Date(`${de}T12:00:00Z`)) / 86400000);
}

function diaDaSemana(data) {
  return DIAS[new Date(`${data}T12:00:00Z`).getUTCDay()];
}

function rotulo(data, fuso) {
  const d = diferencaEmDias(hoje(fuso), data);
  if (d === 0) return 'Hoje';
  if (d === 1) return 'Amanhã';
  return NOME_DO_DIA[diaDaSemana(data)];
}

function porExtenso(data) {
  const [a, m, d] = data.split('-');
  return `${d}/${m}/${a}`;
}

/* --------------------------- matrículas ---------------------------------- */
/**
 * A agenda tem duas origens de gente no mesmo horário:
 *
 *   - RESERVA: alguém marcou pelo app (fica em `agenda-store`).
 *   - FIXO:    a grade da matrícula projetada naquele dia (`matriculas-store`
 *              + `grade.js`), já descontadas as aulas desmarcadas e somadas as
 *              extras do dia.
 *
 * Antes só a primeira contava. Com 120 alunos matriculados e nenhum deles
 * reservando pelo app, uma segunda às 18:00 com 13 alunos fixos aparecia como
 * "8 de 8 livres" — e quem reservasse chegaria numa sala lotada. Aqui as duas
 * origens ocupam o mesmo balde.
 */

/** Aulas fixas de um dia, agrupadas por horário. */
function fixosDoDia(data) {
  const mapa = new Map();
  const c = config.ler();
  // Dia em que o estúdio não abre não tem aula fixa. Sem esta linha o feriado
  // bloqueava a agenda para quem quisesse marcar e ainda assim listava treze
  // alunos na Grade do dia, com a sala fechada.
  if ((c.agenda.datasBloqueadas || []).includes(data)) return mapa;
  if (c.agenda.contarMatriculasNaLotacao === false) return mapa;
  const excecoes = matriculas.excecoes({ de: data, ate: data });
  for (const item of grade.agendaDoDia(matriculas.listar(), data, excecoes)) {
    if (!mapa.has(item.hora)) mapa.set(item.hora, []);
    mapa.get(item.hora).push(item);
  }
  return mapa;
}

/** Aulas fixas de UMA matrícula num dia — usado nos limites e no cancelamento. */
function fixosDaMatricula(matricula, data) {
  if (!matricula) return [];
  return grade.agendaDoDia(
    [matricula], data,
    matriculas.excecoes({ de: data, ate: data, matriculaId: matricula.id }));
}

/**
 * Uma aula desmarcada vira crédito de reposição sozinha?
 *
 * Por padrão não. Crédito é concessão do estúdio — viagem avisada, atestado,
 * dia em que a sala não abriu — e é lá que mora o motivo, que é o que a
 * recepção precisa poder mostrar quando alguém questionar o saldo. Ligando
 * `creditoAutomatico`, desmarcar com antecedência passa a valer crédito: o
 * critério vira o aviso, porque com antecedência a vaga volta para a agenda e
 * outra pessoa aproveita, e em cima da hora ninguém aproveita.
 */
function geraCredito(data, hora) {
  const c = config.ler();
  if (c.agenda.creditoReposicao === false) return false;
  if (c.agenda.creditoAutomatico !== true) return false;
  const minimo = Number(c.agenda.horasParaGerarCredito || 0) * 60;
  return minutosAte(data, hora, c.estudio.fuso) >= minimo;
}

/** Créditos de reposição de uma matrícula, já com a validade configurada. */
function creditosDe(matricula) {
  const c = config.ler();
  if (!matricula || c.agenda.creditoReposicao === false) return { saldo: 0, creditos: [] };
  return grade.creditosDaMatricula(
    matricula,
    matriculas.excecoes({ matriculaId: matricula.id }),
    { hoje: hoje(c.estudio.fuso), validadeDias: Number(c.agenda.validadeCreditoDias || 0) });
}

/** O crédito mais antigo ainda válido — é ele que a próxima reposição gasta. */
function creditoAUsar(matricula) {
  return creditosDe(matricula).creditos.find((c) => c.situacao === 'disponivel') || null;
}

/** Domingo da semana de uma data — a frequência da matrícula é semanal. */
function domingoDa(data) {
  const d = new Date(`${data}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}

/**
 * Lotação de um horário, sem contar ninguém duas vezes: quem tem aula fixa e
 * ainda assim reservou pelo app ocupa um lugar só.
 */
function lotacao(data, hora, naGrade) {
  const reservas = store.doHorario(data, hora);
  const telsFixos = new Set(naGrade.map((f) => f.telefone).filter(Boolean));
  const avulsas = reservas.filter((r) => !telsFixos.has(r.telefone));
  return { reservas, avulsas, ocupadas: naGrade.length + avulsas.length };
}

/**
 * Dias com aula na semana da data, olhando fixos e reservas juntos.
 * Devolve também se o próprio dia já tem aula: marcar um segundo horário num
 * dia que já conta não gasta uma nova ida da semana — quem cuida disso é o
 * `limitePorDia`.
 */
function semanaDaMatricula(matricula, telefone, data) {
  const inicio = domingoDa(data);
  const datas = [];
  let noDia = 0;
  for (let i = 0; i < 7; i++) {
    const d = somarDias(inicio, i);
    const horas = new Set(fixosDaMatricula(matricula, d).map((x) => x.hora));
    if (telefone) {
      for (const a of store.daData(d)) if (a.telefone === telefone) horas.add(a.hora);
    }
    if (!horas.size) continue;
    if (d === data) noDia = horas.size; else datas.push(d);
  }
  const dias = datas.length;
  // `datas` sai junto porque quem soma crédito à conta da semana precisa saber
  // quais dias já entraram, e não só quantos: um crédito do mesmo dia que já
  // foi reposto contaria duas vezes.
  return { dias, noDia, total: dias + (noDia ? 1 : 0), datas, inicio };
}

/* ------------------------------ agenda ----------------------------------- */

/** Minutos viram texto de gente: 90 → "1h30", 120 → "2 horas". */
function emTextoDeTempo(min) {
  const n = Number(min) || 0;
  if (n < 60) return `${n} minutos`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  if (m) return `${h}h${String(m).padStart(2, '0')}`;
  return h === 1 ? '1 hora' : `${h} horas`;
}

/** Minutos entre agora e o começo do horário. Negativo = já passou. */
function minutosAte(data, hora, fuso) {
  return diferencaEmDias(hoje(fuso), data) * 1440 + emMinutos(hora) - agoraEmMinutos(fuso);
}

function datasAbertas(dias) {
  const c = config.ler();
  const fuso = c.estudio.fuso;
  const inicio = hoje(fuso);
  const total = Math.max(0, Number(dias === undefined ? c.agenda.diasAntecedencia : dias) || 0);
  return Array.from({ length: total + 1 }, (_, i) => somarDias(inicio, i));
}

/**
 * Até onde a agenda vai para esta pessoa.
 *
 * A janela normal é curta de propósito — abrir o mês inteiro enche a agenda de
 * marcação que ninguém honra. Mas reposição não se marca para amanhã: quem
 * viajou volta daqui a duas semanas e precisa achar a aula. Então quem tem
 * crédito na mão enxerga mais longe, e só enquanto tiver.
 */
function janelaDe(matricula) {
  const c = config.ler();
  const base = Number(c.agenda.diasAntecedencia) || 0;
  if (!matricula) return base;
  if (!creditosDe(matricula).saldo) return base;
  return Math.max(base, Number(c.agenda.diasAntecedenciaReposicao) || 0);
}

/**
 * Monta um dia com todos os horários e a situação de cada um.
 *
 * `saldoCreditos` chega pronto de `montarDias`: contar crédito é varrer as
 * exceções da matrícula, e refazer isso em cada um dos vinte e dois dias da
 * janela seria a mesma varredura vinte e duas vezes por request.
 */
function montarDia(data, telefone, minhaMatricula, saldoCreditos) {
  const c = config.ler();
  const fuso = c.estudio.fuso;
  const bloqueada = (c.agenda.datasBloqueadas || []).includes(data);
  const padrao = Number(c.agenda.capacidadePadrao) || 0;
  const modelo = (c.agenda.horarios[diaDaSemana(data)] || []).map((s) => ({
    hora: s.hora,
    capacidade: Number(s.capacidade) || padrao,
    foraDaAgenda: false,
  }));

  const fixos = fixosDoDia(data);
  const minha = minhaMatricula === undefined
    ? (telefone ? matriculas.porTelefone(telefone) : null)
    : minhaMatricula;

  /**
   * Horário que tem aula mas não está na configuração da agenda.
   *
   * Isso acontece quando a grade da matrícula usa um horário que ninguém
   * cadastrou em Configurações, ou quando o horário foi removido de lá depois
   * que as aulas já existiam. A aula continua acontecendo — e antes ela
   * simplesmente não aparecia nesta tela, então o aluno via o dia sem o próprio
   * horário e não tinha como desmarcar nem trocar. Agora ela aparece, marcada
   * como fora da agenda: dá para largar, não dá para outra pessoa entrar.
   *
   * O aluno vê só as próprias; a lista do estúdio (sem telefone) vê todas.
   */
  const configuradas = new Set(modelo.map((s) => s.hora));
  const foraDaAgenda = new Set();
  for (const [hora, itens] of fixos) {
    if (configuradas.has(hora)) continue;
    if (telefone && !(minha && itens.some((f) => f.matriculaId === minha.id))) continue;
    foraDaAgenda.add(hora);
  }
  for (const r of store.daData(data)) {
    if (configuradas.has(r.hora)) continue;
    if (telefone && r.telefone !== telefone) continue;
    foraDaAgenda.add(r.hora);
  }
  for (const hora of foraDaAgenda) {
    modelo.push({ hora, capacidade: padrao, foraDaAgenda: true });
  }
  modelo.sort((a, b) => emMinutos(a.hora) - emMinutos(b.hora));

  // Marcar mais uma aula neste dia estoura a semana? A conta é do dia, não do
  // horário — vale igual para todos os slots.
  const estouro = estouraFrequencia(minha, telefone, data);
  const saldo = !estouro ? 0
    : (saldoCreditos === undefined ? creditosDe(minha).saldo : saldoCreditos);

  const horarios = modelo.map((slot) => {
    const capacidade = slot.capacidade;
    const naGrade = fixos.get(slot.hora) || [];
    const { reservas, ocupadas } = lotacao(data, slot.hora, naGrade);

    const meuFixo = minha ? naGrade.find((f) => f.matriculaId === minha.id) : null;
    const meu = telefone ? reservas.find((r) => r.telefone === telefone) : null;

    const faltam = minutosAte(data, slot.hora, fuso);
    const fechou = faltam < Number(c.agenda.minutosAntesDeFechar || 0);
    const aTempo = c.agenda.permitirCancelar &&
      faltam >= Number(c.agenda.minutosParaCancelar || 0);

    let situacao = 'aberto';
    if (bloqueada) situacao = 'bloqueado';
    else if (meuFixo || meu) situacao = 'meu';
    else if (fechou) situacao = 'fechado';
    // Horário fora da configuração não é oferecido para mais ninguém: quem já
    // está nele continua, quem não está não entra.
    else if (slot.foraDaAgenda) situacao = 'fechado';
    else if (ocupadas >= capacidade) situacao = 'lotado';
    // Semana cheia e sem crédito: o horário existe e tem vaga, mas não é para
    // esta pessoa. Deixar aberto só para recusar no clique é o beco sem saída
    // que a tela deveria evitar.
    else if (estouro && !saldo) situacao = 'fechado';

    // Quando a aula é sua mas não dá para mexer nela, a tela precisa dizer por
    // quê. Um selo mudo vira um beco sem saída: a pessoa acha que o app está
    // quebrado quando na verdade é uma regra do estúdio.
    let motivoTravado = null;
    if ((meuFixo || meu) && !aTempo) {
      const minimo = Number(c.agenda.minutosParaCancelar || 0);
      motivoTravado = !c.agenda.permitirCancelar
        ? 'O estúdio não abriu cancelamento e troca pelo app.'
        : `Trocar ou desmarcar só até ${emTextoDeTempo(minimo)} antes.`;
    } else if (estouro && !saldo && !bloqueada && !fechou && !slot.foraDaAgenda) {
      motivoTravado = `Sua matrícula é de ${estouro.frequencia}x por semana e você já ` +
        `tem ${estouro.dias} ${estouro.dias === 1 ? 'dia' : 'dias'} nesta semana. ` +
        'Para encaixar mais uma, fale com o estúdio.';
    }

    return {
      hora: slot.hora,
      capacidade,
      foraDaAgenda: Boolean(slot.foraDaAgenda),
      motivoTravado,
      ocupadas,
      vagas: Math.max(0, capacidade - ocupadas),
      // Abertura da conta: o aluno entende por que um horário "vazio" já tem
      // gente. `naGrade` é matrícula; `avulsas`, quem marcou pelo app.
      naGrade: naGrade.length,
      avulsas: ocupadas - naGrade.length,
      situacao,
      // 'fixo' = veio da matrícula (a pessoa não precisou reservar);
      // 'extra' = aula avulsa lançada pelo estúdio; 'reserva' = marcou no app.
      origem: meuFixo ? (meuFixo.origem === 'extra' ? 'extra' : 'fixo') : (meu ? 'reserva' : null),
      meuAgendamentoId: meu ? meu.id : null,
      podeCancelar: Boolean(meu) && aTempo,
      // Desmarcar aula fixa não cancela agendamento nenhum: registra uma
      // exceção na matrícula. Por isso vai num campo separado.
      podeDesmarcar: Boolean(meuFixo) && !meu && aTempo,
      // Trocar vale para as duas naturezas: aula da matrícula e reserva.
      podeTrocar: Boolean(meuFixo || meu) && aTempo,
      // Marcar aqui gasta um crédito de reposição. A tela precisa avisar antes
      // do clique: crédito é escasso e a pessoa escolhe onde gastar.
      custaCredito: Boolean(estouro) && situacao === 'aberto',
    };
  });

  return {
    data,
    rotulo: rotulo(data, fuso),
    porExtenso: porExtenso(data),
    bloqueada,
    horarios,
  };
}

function montarDias(telefone) {
  const minha = telefone ? matriculas.porTelefone(telefone) : null;
  const saldo = minha ? creditosDe(minha).saldo : 0;
  const dias = Math.max(
    Number(config.ler().agenda.diasAntecedencia) || 0,
    saldo ? (Number(config.ler().agenda.diasAntecedenciaReposicao) || 0) : 0);
  return datasAbertas(dias).map((d) => montarDia(d, telefone, minha, saldo));
}

/**
 * A matrícula do aluno logado, como a tela precisa ver: frequência contratada,
 * horário padrão e quanto já foi usado nesta semana.
 */
function minhaMatricula(telefone, data) {
  const m = matriculas.porTelefone(telefone);
  if (!m) return null;
  const semana = semanaDaMatricula(m, telefone, data);
  const frequencia = grade.diasPorSemana(m);
  return {
    id: m.id,
    nome: m.nome,
    vinculo: m.vinculo || null,
    frequencia,
    gradeEmTexto: grade.gradeEmTexto(m),
    grade: m.grade || [],
    diasNaSemana: semana.total,
    diasRestantesNaSemana: frequencia ? Math.max(0, frequencia - semana.total) : null,
    respeitarFrequencia: config.ler().agenda.respeitarFrequencia !== false,
    // Saldo de reposição. A tela mostra, mas ainda não é ele que autoriza a
    // reserva além da frequência — encaixe continua passando pelo estúdio.
    creditos: creditosDe(m),
  };
}

/**
 * Marcar aula neste dia estoura a frequência contratada?
 *
 * Só aqui o crédito entra em jogo. Quem ainda tem dia livre na semana marca
 * normalmente e não gasta nada — gastar crédito numa aula que ele já tinha
 * direito seria cobrar duas vezes pela mesma coisa.
 */
function estouraFrequencia(matricula, telefone, data) {
  const c = config.ler();
  if (!matricula || c.agenda.respeitarFrequencia === false) return null;
  const frequencia = grade.diasPorSemana(matricula);
  if (!frequencia) return null;
  const semana = semanaDaMatricula(matricula, telefone, data);
  if (semana.noDia) return null;

  // A aula perdida que virou crédito continua ocupando o lugar dela na semana
  // até o crédito ser gasto. Sem isso, quem desmarcava a segunda e remarcava
  // na terça ficava com os dois dias e ainda saía com o crédito na mão: repunha
  // de graça e guardava o direito a uma terceira aula em outra semana.
  const fim = somarDias(semana.inicio, 6);
  const jaContados = new Set([...semana.datas, data]);
  const reservados = new Set(
    creditosDe(matricula).creditos
      .filter((x) => x.situacao === 'disponivel' &&
        x.data >= semana.inicio && x.data <= fim && !jaContados.has(x.data))
      .map((x) => x.data));

  const dias = semana.dias + reservados.size;
  if (dias < frequencia) return null;
  return { frequencia, dias };
}

/**
 * Reserva uma vaga. Todas as checagens e a gravação acontecem no mesmo
 * passo síncrono — o Node não intercala, então duas pessoas não pegam a
 * mesma última vaga. Isso vale enquanto o serviço roda em UMA réplica.
 *
 * Quem estourou a frequência da semana e tem crédito de reposição marca
 * sozinho: o crédito já é a autorização do estúdio, dada quando ele foi
 * concedido. Mandar a pessoa ligar para a recepção de novo, com o crédito na
 * mão, é pedir a mesma permissão duas vezes.
 */
function reservar(aluno, data, hora) {
  const c = config.ler();
  const fuso = c.estudio.fuso;

  const minha = matriculas.porTelefone(aluno.telefone);

  if (!datasAbertas(janelaDe(minha)).includes(data)) {
    return { ok: false, motivo: 'Esse dia não está aberto para agendamento.' };
  }
  if ((c.agenda.datasBloqueadas || []).includes(data)) {
    return { ok: false, motivo: 'O estúdio não abre nesse dia.' };
  }

  const slot = (c.agenda.horarios[diaDaSemana(data)] || []).find((s) => s.hora === hora);
  if (!slot) return { ok: false, motivo: 'Esse horário não existe na agenda.' };

  const faltam = minutosAte(data, hora, fuso);
  if (faltam < Number(c.agenda.minutosAntesDeFechar || 0)) {
    return { ok: false, motivo: 'Esse horário já fechou.' };
  }
  if (store.jaTem(aluno.telefone, data, hora)) {
    return { ok: false, motivo: 'Você já está nesse horário.' };
  }

  const meusFixos = fixosDaMatricula(minha, data);
  if (meusFixos.some((x) => x.hora === hora)) {
    return { ok: false, motivo: 'Esse já é o seu horário fixo — você não precisa reservar.' };
  }

  // O limite do dia conta a aula da matrícula junto: quem já tem aula fixa às
  // 18:00 não pega mais uma às 19:00 num estúdio com limite de 1 por dia.
  const limite = Number(c.agenda.limitePorDia) || 0;
  const noDia = store.contarNoDia(aluno.telefone, data) + meusFixos.length;
  if (limite > 0 && noDia >= limite) {
    return {
      ok: false,
      motivo: limite === 1
        ? 'Você já tem um horário nesse dia.'
        : `Você já tem ${limite} horários nesse dia.`,
    };
  }

  // Frequência da matrícula: 3x por semana são três idas, não três por dia.
  // Estourar isso exige um crédito de reposição; sem crédito, a decisão volta
  // a ser do estúdio e a mensagem manda falar com a recepção.
  const estouro = estouraFrequencia(minha, aluno.telefone, data);
  let credito = null;
  if (estouro) {
    credito = creditoAUsar(minha);
    if (!credito) {
      return {
        ok: false,
        motivo: `Sua matrícula é de ${estouro.frequencia}x por semana e você já tem ` +
          `${estouro.dias} ${estouro.dias === 1 ? 'dia' : 'dias'} de aula nesta semana. ` +
          'Para encaixar mais uma, fale com o estúdio.',
      };
    }
  }

  const capacidade = Number(slot.capacidade) || Number(c.agenda.capacidadePadrao) || 0;
  const naGrade = fixosDoDia(data).get(hora) || [];
  if (lotacao(data, hora, naGrade).ocupadas >= capacidade) {
    return { ok: false, motivo: 'As vagas desse horário acabaram.' };
  }

  // Quem tem matrícula ganha uma aula extra nela, não uma reserva solta: é
  // assim que a aula aparece na Grade do dia junto das outras daquele horário,
  // e é o único registro que o crédito consegue apontar.
  if (minha) {
    const r = matriculas.registrarExcecao({
      matriculaId: minha.id, data, tipo: 'extra', hora,
      motivo: credito
        ? `Reposição da aula de ${porExtenso(credito.data)}`
        : 'Marcado pelo aluno no app',
      reposicaoDe: credito ? credito.id : null,
    });
    if (!r.ok) return r;
    return {
      ok: true,
      excecao: r.excecao,
      reposicao: Boolean(credito),
      saldo: creditosDe(minha).saldo,
    };
  }

  const registro = store.reservar({
    telefone: aluno.telefone, nome: aluno.nome, data, hora,
  });
  return { ok: true, agendamento: registro };
}

function cancelar(aluno, id, ehAdmin) {
  const c = config.ler();
  const a = store.porId(id);
  if (!a || a.status !== 'ativo') return { ok: false, motivo: 'Agendamento não encontrado.' };
  if (!ehAdmin && a.telefone !== aluno.telefone) {
    return { ok: false, motivo: 'Esse agendamento não é seu.' };
  }
  if (!ehAdmin) {
    if (!c.agenda.permitirCancelar) {
      return { ok: false, motivo: 'Cancelamento pelo app está desligado. Fale com o estúdio.' };
    }
    const faltam = minutosAte(a.data, a.hora, c.estudio.fuso);
    const minimo = Number(c.agenda.minutosParaCancelar || 0);
    if (faltam < minimo) {
      return { ok: false, motivo: `Cancelamento só até ${minimo} minutos antes do horário.` };
    }
  }
  store.cancelar(id, ehAdmin ? 'estudio' : 'aluno');
  return { ok: true };
}

/**
 * Desmarcar uma aula da matrícula. Não existe agendamento para cancelar aqui:
 * a aula é uma projeção da grade, então o que gravamos é a exceção do dia. O
 * lugar volta para a agenda na hora, porque a lotação é recalculada a cada
 * leitura.
 */
function desmarcarFixa(aluno, data, hora) {
  const c = config.ler();
  const minha = matriculas.porTelefone(aluno.telefone);
  if (!minha) {
    return { ok: false, motivo: 'Seu telefone ainda não está ligado a uma matrícula. Fale com o estúdio.' };
  }
  if (!c.agenda.permitirCancelar) {
    return { ok: false, motivo: 'Cancelamento pelo app está desligado. Fale com o estúdio.' };
  }
  const item = fixosDaMatricula(minha, data).find((x) => x.hora === hora);
  if (!item) return { ok: false, motivo: 'Você não tem aula fixa nesse horário.' };

  const faltam = minutosAte(data, hora, c.estudio.fuso);
  const minimo = Number(c.agenda.minutosParaCancelar || 0);
  if (faltam < minimo) {
    return { ok: false, motivo: `Cancelamento só até ${minimo} minutos antes do horário.` };
  }
  const r = soltarAulaFixa(minha, data, item, { credito: geraCredito(data, hora) });
  if (!r.ok) return r;
  return {
    ok: true,
    excecao: r.excecao || null,
    credito: Boolean(r.excecao && r.excecao.gerouCredito),
    saldo: creditosDe(minha).saldo,
  };
}

/**
 * Trocar a aula de lugar: larga o horário atual e pega outro, num passo só.
 *
 * Fazer isso em dois toques — desmarcar e depois reservar — tem um buraco no
 * meio: entre um e outro, a última vaga do horário novo pode acabar, e a
 * pessoa fica sem nenhum dos dois. Aqui as checagens e a gravação acontecem no
 * mesmo passo síncrono; se o destino não der, nada é mexido e a aula original
 * continua de pé.
 *
 * A frequência da matrícula não é checada de propósito: trocar não acrescenta
 * uma ida na semana, no máximo tira uma.
 */
function trocar(aluno, de, para) {
  const c = config.ler();
  const fuso = c.estudio.fuso;

  if (!de || !para || !de.data || !de.hora || !para.data || !para.hora) {
    return { ok: false, motivo: 'Informe o horário atual e o novo.' };
  }
  if (de.data === para.data && de.hora === para.hora) {
    return { ok: false, motivo: 'Esse já é o seu horário.' };
  }
  if (!c.agenda.permitirCancelar) {
    return { ok: false, motivo: 'Trocar de horário pelo app está desligado. Fale com o estúdio.' };
  }

  /* ---- o que ele tem hoje ---- */
  const minha = matriculas.porTelefone(aluno.telefone);
  const atual = fixosDaMatricula(minha, de.data).find((x) => x.hora === de.hora) || null;
  const reserva = store.doHorario(de.data, de.hora)
    .find((r) => r.telefone === aluno.telefone) || null;
  if (!atual && !reserva) return { ok: false, motivo: 'Você não tem aula nesse horário.' };

  const minimo = Number(c.agenda.minutosParaCancelar || 0);
  if (minutosAte(de.data, de.hora, fuso) < minimo) {
    return { ok: false, motivo: `Troca só até ${minimo} minutos antes do horário.` };
  }

  /* ---- o destino serve? ---- */
  if (!datasAbertas(janelaDe(minha)).includes(para.data)) {
    return { ok: false, motivo: 'Esse dia não está aberto para agendamento.' };
  }
  if ((c.agenda.datasBloqueadas || []).includes(para.data)) {
    return { ok: false, motivo: 'O estúdio não abre nesse dia.' };
  }
  const slot = (c.agenda.horarios[diaDaSemana(para.data)] || [])
    .find((s) => s.hora === para.hora);
  if (!slot) return { ok: false, motivo: 'Esse horário não existe na agenda.' };
  if (minutosAte(para.data, para.hora, fuso) < Number(c.agenda.minutosAntesDeFechar || 0)) {
    return { ok: false, motivo: 'Esse horário já fechou.' };
  }

  const fixosDestino = fixosDaMatricula(minha, para.data);
  if (fixosDestino.some((x) => x.hora === para.hora) ||
      store.jaTem(aluno.telefone, para.data, para.hora)) {
    return { ok: false, motivo: 'Você já está nesse horário.' };
  }

  // Limite do dia no destino, descontando a aula que está saindo quando a
  // troca é dentro do mesmo dia.
  const limite = Number(c.agenda.limitePorDia) || 0;
  if (limite > 0) {
    const saiDoDestino = para.data === de.data ? 1 : 0;
    const noDia = store.contarNoDia(aluno.telefone, para.data) + fixosDestino.length - saiDoDestino;
    if (noDia >= limite) {
      return {
        ok: false,
        motivo: limite === 1
          ? 'Você já tem um horário nesse dia.'
          : `Você já tem ${limite} horários nesse dia.`,
      };
    }
  }

  // A vaga que ele está largando conta a favor dele quando a troca é no mesmo
  // horário de outro dia? Não: a lotação do destino é a do destino.
  const capacidade = Number(slot.capacidade) || Number(c.agenda.capacidadePadrao) || 0;
  const naGrade = fixosDoDia(para.data).get(para.hora) || [];
  if (lotacao(para.data, para.hora, naGrade).ocupadas >= capacidade) {
    return { ok: false, motivo: 'As vagas desse horário acabaram.' };
  }

  /* ---- aplica: solta o antigo, pega o novo ---- */
  if (atual) {
    // Troca não gera crédito: a aula não foi perdida, mudou de lugar. Marcar
    // crédito aqui daria ao aluno uma terceira aula por ter movido a segunda.
    const r = soltarAulaFixa(minha, de.data, atual, { credito: false });
    if (!r.ok) return r;
  }
  if (reserva) store.cancelar(reserva.id, 'aluno');

  // Quem tem matrícula ganha uma aula extra na própria matrícula, não uma
  // reserva solta: assim a troca aparece na Grade do dia do estúdio, junto das
  // outras aulas daquele horário, e não numa lista paralela.
  if (minha) {
    const r = matriculas.registrarExcecao({
      matriculaId: minha.id, data: para.data, tipo: 'extra', hora: para.hora,
      motivo: `Troca do horário de ${porExtenso(de.data)} ${de.hora}`,
    });
    if (!r.ok) return r;
    return { ok: true, excecao: r.excecao };
  }

  const registro = store.reservar({
    telefone: aluno.telefone, nome: aluno.nome, data: para.data, hora: para.hora,
  });
  return { ok: true, agendamento: registro };
}

/**
 * Solta uma aula da matrícula. Aula da grade vira exceção de cancelamento;
 * aula extra é apagada, porque cancelar um encaixe é desfazer o encaixe.
 */
function soltarAulaFixa(minha, data, item, { credito = false, motivo } = {}) {
  if (item.origem === 'extra' && item.excecaoId) {
    return matriculas.apagarExcecao(item.excecaoId);
  }
  return matriculas.registrarExcecao({
    matriculaId: minha.id, data, tipo: 'cancelou', hora: item.hora,
    motivo: motivo || 'Desmarcado pelo aluno no app',
    gerouCredito: credito,
  });
}

/** Lista de presença de um dia, para o administrador. */
/**
 * Quem é esperado em cada horário do dia: grade fixa + reservas do app.
 *
 * `presenca: true` (só a tela Lista do dia pede) acrescenta a marca do totem
 * em cada aluno e quem confirmou num horário sem estar inscrito nele. O tablet
 * chama sem a opção de propósito: ele pergunta "onde esta pessoa é esperada",
 * e quem foi liberado às 10h não passou a ser esperado às 10h — senão a
 * segunda passada no tablet entraria como horário normal, sem professor.
 */
function listaDoDia(data, opcoes = {}) {
  const c = config.ler();
  const fuso = c.estudio.fuso;
  const dia = montarDia(data, null, null);
  const fixos = fixosDoDia(data);

  const base = dia.horarios.map((h) => {
    const naGrade = fixos.get(h.hora) || [];
    const telsFixos = new Set(naGrade.map((f) => f.telefone).filter(Boolean));
    const alunos = [
      ...naGrade.map((f) => ({
        id: null,
        matriculaId: f.matriculaId,
        nome: f.nome || 'Sem nome',
        telefone: f.telefone || null,
        vinculo: f.vinculo || null,
        origem: f.origem,          // 'fixo' | 'extra'
        criadoEm: null,
      })),
      ...store.doHorario(data, h.hora)
        .filter((r) => !telsFixos.has(r.telefone))
        .map((r) => ({
          id: r.id,
          matriculaId: null,
          nome: r.nome || 'Sem nome',
          telefone: r.telefone,
          vinculo: null,
          origem: 'reserva',
          criadoEm: r.criadoEm,
        })),
    ].sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'));

    return { ...h, alunos };
  });

  if (!opcoes.presenca) return { ...dia, horarios: base, hoje: hoje(fuso) };

  // PRESENÇA É GESTÃO, NÃO COBRANÇA
  //   A marca de cada aluno diz se ele confirmou no totem, se foi liberado fora
  //   do horário ou se veio em outra aula do dia. Serve para acompanhar a turma
  //   e ensinar a chegar na hora; não mexe em frequência nem gera cobrança —
  //   isso continua sendo só o check-in do Wellhub (`presencas.js`).
  const pres = presencas.doDia(data);
  const final = presencas.finalDoTelefone;
  const tolerancia = Number((c.totem && c.totem.minutosDepois) ?? 20);
  const horasDaGrade = new Set(dia.horarios.map((h) => h.hora));

  function marcar(aluno, hora) {
    const f = final(aluno.telefone);
    const doDia = f ? (pres.porFinal.get(f) || []) : [];
    const aqui = doDia.find((p) => p.hora === hora);
    const outra = aqui ? null : doDia[0] || null;

    let presenca;
    if (aqui) {
      presenca = {
        estado: aqui.liberado ? 'liberado' : 'confirmou',
        chegada: aqui.chegada, liberadoPor: aqui.liberadoPor,
      };
    } else if (outra) {
      presenca = { estado: 'outro-horario', hora: outra.hora, chegada: outra.chegada };
    } else if (!f) {
      // Aluno sem telefone na ficha não tem como confirmar no tablet. Marcar
      // "não confirmou" seria culpar a pessoa por um cadastro incompleto.
      presenca = { estado: 'sem-telefone' };
    } else if (minutosAte(data, hora, fuso) < -tolerancia) {
      // Só depois de fechada a janela do tablet. Antes disso a pessoa ainda
      // pode chegar, e marcar "não confirmou" às 9h59 da aula das 10h seria
      // ruído na tela de quem está organizando a sala.
      presenca = { estado: 'nao-confirmou' };
    } else {
      presenca = { estado: 'aguardando' };
    }
    return {
      ...aluno,
      presenca,
      semCheckinWellhub: Boolean(f && pres.semCheckinWellhub.has(f)),
    };
  }

  const horarios = base.map((h) => {
    const inscritos = h.alunos.map((a) => {
      // Reserva feita pelo app não traz a ficha; o vínculo é o que decide o
      // aviso de check-in do Wellhub, então busca pelo telefone.
      if (a.origem !== 'reserva') return marcar(a, h.hora);
      const m = matriculas.porTelefone(a.telefone);
      return marcar({ ...a, matriculaId: m ? m.id : null, vinculo: m ? (m.vinculo || null) : null }, h.hora);
    });

    // Quem confirmou neste horário sem estar na lista dele: trocou de aula no
    // mesmo dia sem remarcar, ou foi liberado pelo professor. Entra na turma
    // para a lista mostrar quem de fato estava na sala, mas não ocupa vaga na
    // contagem de lotação.
    const finaisInscritos = new Set(inscritos.map((a) => final(a.telefone)).filter(Boolean));
    const avulsos = pres.registros
      .filter((p) => p.hora === h.hora && p.final && !finaisInscritos.has(p.final))
      .map((p) => marcar({
        id: null, matriculaId: p.matriculaId, nome: p.nome || 'Sem nome',
        telefone: p.telefone, vinculo: p.vinculo, origem: 'presenca', criadoEm: null,
      }, h.hora));

    const alunos = [...inscritos, ...avulsos]
      .sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'));

    return {
      ...h,
      alunos,
      inscritos: inscritos.length,
      presentes: alunos.filter((a) => ['confirmou', 'liberado'].includes(a.presenca.estado)).length,
    };
  });

  // Confirmação num horário que não existe na grade do dia (sala aberta fora
  // do previsto, grade editada depois). Sem este bloco ela sumiria da tela.
  const foraDaGrade = pres.registros
    .filter((p) => !horasDaGrade.has(p.hora))
    .map((p) => ({
      id: null, matriculaId: p.matriculaId, nome: p.nome || 'Sem nome', telefone: p.telefone,
      vinculo: p.vinculo, origem: 'presenca', criadoEm: null, hora: p.hora,
      presenca: { estado: p.liberado ? 'liberado' : 'confirmou', chegada: p.chegada, liberadoPor: p.liberadoPor },
      semCheckinWellhub: Boolean(p.final && pres.semCheckinWellhub.has(p.final)),
    }));

  const todos = [...horarios.flatMap((h) => h.alunos), ...foraDaGrade];
  const contar = (estado) => todos.filter((a) => a.presenca.estado === estado).length;

  // Um nome por pessoa: quem aparece em dois horários (inscrita num, presente
  // noutro) não pode contar duas vezes no aviso do Wellhub.
  const wellhubSemCheckin = [];
  const vistos = new Set();
  for (const r of pres.registros) {
    if (!r.final || !pres.semCheckinWellhub.has(r.final) || vistos.has(r.final)) continue;
    vistos.add(r.final);
    wellhubSemCheckin.push({ nome: r.nome || 'Sem nome', hora: r.hora, matriculaId: r.matriculaId });
  }

  return {
    ...dia,
    horarios,
    foraDaGrade,
    presenca: {
      confirmaram: contar('confirmou'),
      liberados: contar('liberado'),
      outroHorario: contar('outro-horario'),
      naoConfirmaram: contar('nao-confirmou'),
      wellhubSemCheckin,
    },
    hoje: hoje(fuso),
  };
}

module.exports = {
  hoje, montarDia, montarDias, datasAbertas, reservar, cancelar, desmarcarFixa, trocar,
  listaDoDia, minhaMatricula, semanaDaMatricula, fixosDaMatricula,
  geraCredito, creditosDe, creditoAUsar, janelaDe, estouraFrequencia,
  diaDaSemana, porExtenso, minutosAte, emTextoDeTempo, DIAS, NOME_DO_DIA,
};
