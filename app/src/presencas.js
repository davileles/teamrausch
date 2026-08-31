'use strict';

/**
 * app/src/presencas.js — davileles/teamrausch
 *
 * De onde vem "o aluno treinou neste dia". Hoje há uma fonte só — o check-in
 * do portal do Wellhub. Quando o módulo de confirmação de presença no estúdio
 * existir, ele entra aqui e mais nada muda de lugar.
 *
 * POR QUE ESTE ARQUIVO EXISTE ANTES DA SEGUNDA FONTE
 *   Quatro lugares perguntavam direto ao `checkins-store` quem treinou quando:
 *   o painel de frequência, o aviso diário, a ficha do aluno e a lista de
 *   destinatários das mensagens. Ligar a confirmação de presença significaria
 *   lembrar dos quatro — e o que fosse esquecido continuaria cobrando alguém
 *   que apareceu. Agora é um lugar só.
 *
 * O QUE FALTA PARA LIGAR (checklist do módulo futuro)
 *   1. Registrar a confirmação: `agenda-store` ganha presença por agendamento
 *      ('compareceu' | 'faltou'), marcada na aba Lista do dia.
 *   2. Devolver essas datas em `deConfirmacao()`, abaixo — hoje ela devolve um
 *      mapa vazio e é o único ponto a mexer.
 *   3. Trocar CONFIRMACAO_ATIVA para true. `vinculosComDado()` passa a incluir
 *      mensalista sozinho, e as cobranças param de excluí-lo.
 *
 * DIA, NÃO APARIÇÃO
 *   As duas fontes podem falar do mesmo treino: o aluno passa o QR do Wellhub
 *   e a recepção confirma a presença dele. União de datas, sem repetir — a
 *   grade conta dias, e contar duas vezes faria a pessoa parecer adiantada.
 */

const checkins = require('./checkins-store');

/**
 * Vira true quando o módulo de confirmação estiver no ar. Enquanto for false,
 * quem não é Wellhub não tem como provar que treinou, e cobrar essa pessoa é
 * acusar quem veio.
 */
const CONFIRMACAO_ATIVA = String(process.env.PRESENCA_CONFIRMACAO_ATIVA || 'false') === 'true';

/**
 * Datas com presença confirmada no estúdio, por matrícula.
 * Enquanto o módulo não existe, devolve vazio — e a união abaixo vira só o
 * Wellhub, que é exatamente o comportamento de hoje.
 *
 * @returns {Map<string, string[]>} matriculaId → ['AAAA-MM-DD', …]
 */
function deConfirmacao(/* { de, ate } = {} */) {
  if (!CONFIRMACAO_ATIVA) return new Map();
  // TODO(confirmação de presença): ler os agendamentos marcados como
  // 'compareceu' no `agenda-store` e devolver as datas por matrícula. O
  // agendamento guarda telefone; a ponte com a matrícula é a mesma de
  // `rotas-matriculas.fichaDeLogin` — os 8 dígitos finais do número.
  return new Map();
}

/** Junta duas fontes sem repetir data. */
function unir(a, b) {
  if (!b.size) return a;
  const fora = new Map(a);
  for (const [id, datas] of b) {
    const juntas = new Set(fora.get(id) || []);
    for (const d of datas) juntas.add(d);
    fora.set(id, [...juntas].sort());
  }
  return fora;
}

/**
 * Todas as datas em que cada aluno treinou, de qualquer fonte.
 * Mesma assinatura de `checkins.mapaPorMatricula` de propósito: quem chamava
 * um chama o outro sem mudar mais nada.
 */
function mapaPorMatricula(janela = {}) {
  return unir(checkins.mapaPorMatricula(janela), deConfirmacao(janela));
}

/** Datas de um aluno só. */
function datasDaMatricula(matriculaId) {
  const doEstudio = deConfirmacao().get(matriculaId) || [];
  const doWellhub = checkins.datasDaMatricula(matriculaId) || [];
  if (!doEstudio.length) return doWellhub;
  return [...new Set([...doWellhub, ...doEstudio])].sort();
}

/**
 * Quais vínculos têm dado suficiente para serem cobrados por frequência.
 *
 * Não é uma preferência de negócio — é o limite do que o sistema sabe. O
 * mensalista não faz check-in no portal, então o realizado dele fecha em zero
 * contra a meta da grade e ele apareceria como crítico todos os meses. Com a
 * confirmação de presença ligada, ele passa a ter dado e entra sozinho.
 */
function vinculosComDado() {
  return CONFIRMACAO_ATIVA ? ['wellhub', 'mensalista'] : ['wellhub'];
}

/**
 * `frequencia.painel` aceita um vínculo só, ou null para todos. Enquanto
 * houver uma fonte só, isto devolve 'wellhub'; com as duas, devolve null.
 */
function vinculoParaPainel() {
  const v = vinculosComDado();
  return v.length > 1 ? null : v[0];
}

function situacao() {
  return {
    fontes: CONFIRMACAO_ATIVA ? ['wellhub', 'estudio'] : ['wellhub'],
    confirmacaoAtiva: CONFIRMACAO_ATIVA,
    vinculosComDado: vinculosComDado(),
  };
}

module.exports = {
  mapaPorMatricula, datasDaMatricula, vinculosComDado, vinculoParaPainel,
  situacao, CONFIRMACAO_ATIVA,
};
