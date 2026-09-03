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
 * COMO A SEGUNDA FONTE FICOU
 *   O tablet da entrada grava em `agenda-store.presencas` — registro próprio,
 *   não um campo do agendamento, porque quem treina na grade fixa da matrícula
 *   não tem agendamento nenhum para marcar. `deConfirmacao()` traduz telefone
 *   em matrícula e devolve as datas.
 *
 *   Falta só ligar: `PRESENCA_CONFIRMACAO_ATIVA=true` no Railway. Enquanto for
 *   false, o tablet registra e nada mais muda — dá para acumular alguns dias de
 *   confirmação e conferir contra o Wellhub antes de deixar isso valer nas
 *   cobranças de frequência.
 *
 * DIA, NÃO APARIÇÃO
 *   As duas fontes podem falar do mesmo treino: o aluno passa o QR do Wellhub
 *   e a recepção confirma a presença dele. União de datas, sem repetir — a
 *   grade conta dias, e contar duas vezes faria a pessoa parecer adiantada.
 */

const checkins = require('./checkins-store');
const agendaStore = require('./agenda-store');
const matriculas = require('./matriculas-store');

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
function deConfirmacao(janela = {}) {
  if (!CONFIRMACAO_ATIVA) return new Map();

  // A presença guarda telefone, que é a chave do cadastro de login; a
  // frequência conta por matrícula. `matriculas.porTelefone` é a mesma ponte
  // usada no resto do sistema — compara os 8 dígitos finais, então DDI e nono
  // dígito digitados de formas diferentes continuam sendo a mesma pessoa.
  //
  // Presença de quem não tem ficha simplesmente não entra: não há a quem
  // creditar, e inventar uma matrícula aqui poluiria a base de cobrança.
  const porMatricula = new Map();
  const cache = new Map();

  for (const p of agendaStore.listarPresencas(janela)) {
    if (!cache.has(p.telefone)) {
      const m = matriculas.porTelefone(p.telefone);
      cache.set(p.telefone, m ? m.id : null);
    }
    const id = cache.get(p.telefone);
    if (!id) continue;
    const datas = porMatricula.get(id) || new Set();
    datas.add(p.data);
    porMatricula.set(id, datas);
  }

  return new Map([...porMatricula].map(([id, datas]) => [id, [...datas].sort()]));
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
