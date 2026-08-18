'use strict';

const config = require('./config');
const store = require('./agenda-store');

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

/* ------------------------------ agenda ----------------------------------- */

/** Minutos entre agora e o começo do horário. Negativo = já passou. */
function minutosAte(data, hora, fuso) {
  return diferencaEmDias(hoje(fuso), data) * 1440 + emMinutos(hora) - agoraEmMinutos(fuso);
}

function datasAbertas() {
  const c = config.ler();
  const fuso = c.estudio.fuso;
  const inicio = hoje(fuso);
  const total = Math.max(0, Number(c.agenda.diasAntecedencia) || 0);
  return Array.from({ length: total + 1 }, (_, i) => somarDias(inicio, i));
}

/** Monta um dia com todos os horários e a situação de cada um. */
function montarDia(data, telefone) {
  const c = config.ler();
  const fuso = c.estudio.fuso;
  const bloqueada = (c.agenda.datasBloqueadas || []).includes(data);
  const modelo = (c.agenda.horarios[diaDaSemana(data)] || [])
    .slice()
    .sort((a, b) => emMinutos(a.hora) - emMinutos(b.hora));

  const horarios = modelo.map((slot) => {
    const capacidade = Number(slot.capacidade) || Number(c.agenda.capacidadePadrao) || 0;
    const reservas = store.doHorario(data, slot.hora);
    const meu = telefone ? reservas.find((r) => r.telefone === telefone) : null;
    const faltam = minutosAte(data, slot.hora, fuso);
    const fechou = faltam < Number(c.agenda.minutosAntesDeFechar || 0);

    let situacao = 'aberto';
    if (bloqueada) situacao = 'bloqueado';
    else if (meu) situacao = 'meu';
    else if (fechou) situacao = 'fechado';
    else if (reservas.length >= capacidade) situacao = 'lotado';

    return {
      hora: slot.hora,
      capacidade,
      ocupadas: reservas.length,
      vagas: Math.max(0, capacidade - reservas.length),
      situacao,
      meuAgendamentoId: meu ? meu.id : null,
      podeCancelar: Boolean(meu) && c.agenda.permitirCancelar &&
        faltam >= Number(c.agenda.minutosParaCancelar || 0),
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
  return datasAbertas().map((d) => montarDia(d, telefone));
}

/**
 * Reserva uma vaga. Todas as checagens e a gravação acontecem no mesmo
 * passo síncrono — o Node não intercala, então duas pessoas não pegam a
 * mesma última vaga. Isso vale enquanto o serviço roda em UMA réplica.
 */
function reservar(aluno, data, hora) {
  const c = config.ler();
  const fuso = c.estudio.fuso;

  if (!datasAbertas().includes(data)) {
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

  const limite = Number(c.agenda.limitePorDia) || 0;
  if (limite > 0 && store.contarNoDia(aluno.telefone, data) >= limite) {
    return {
      ok: false,
      motivo: limite === 1
        ? 'Você já tem um horário nesse dia.'
        : `Você já tem ${limite} horários nesse dia.`,
    };
  }

  const capacidade = Number(slot.capacidade) || Number(c.agenda.capacidadePadrao) || 0;
  if (store.doHorario(data, hora).length >= capacidade) {
    return { ok: false, motivo: 'As vagas desse horário acabaram.' };
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

/** Lista de presença de um dia, para o administrador. */
function listaDoDia(data) {
  const c = config.ler();
  const dia = montarDia(data, null);
  return {
    ...dia,
    horarios: dia.horarios.map((h) => ({
      ...h,
      alunos: store.doHorario(data, h.hora).map((r) => ({
        id: r.id,
        nome: r.nome || 'Sem nome',
        telefone: r.telefone,
        criadoEm: r.criadoEm,
      })),
    })),
    hoje: hoje(c.estudio.fuso),
  };
}

module.exports = {
  hoje, montarDia, montarDias, datasAbertas, reservar, cancelar, listaDoDia,
  diaDaSemana, porExtenso, minutosAte, DIAS, NOME_DO_DIA,
};
