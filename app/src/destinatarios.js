'use strict';

/**
 * app/src/destinatarios.js — davileles/teamrausch
 *
 * Traduz um "público" (todos, wellhub, mensalista, devedores) na lista de
 * alunos que vai receber a mensagem, já com os valores dos marcadores.
 *
 * FICA SEPARADO DAS ROTAS DE PROPÓSITO
 *   A tela monta a lista antes de disparar, e o agendador monta a mesma lista
 *   sozinho na hora do envio programado. Se cada um calculasse do seu jeito,
 *   "todos os ativos" acabaria significando coisas diferentes nos dois lugares
 *   — e a diferença só apareceria quando alguém reclamasse de não ter recebido.
 *
 * SEM TELEFONE NÃO É ERRO, É AVISO
 *   Boa parte da base veio da planilha sem telefone. Esses alunos entram na
 *   contagem e aparecem na tela marcados, em vez de sumirem em silêncio: o
 *   número que falta é informação sua, não um problema para esconder.
 */

const matriculas = require('./matriculas-store');
const alunosLogin = require('./agenda-store');
const alertas = require('./alertas-frequencia');
const frequencia = require('./frequencia');
const telefone = require('./telefone');
const presencas = require('./presencas');
const config = require('./config');

/**
 * Dias sem aparecer a partir dos quais o aluno entra no público 'ausentes',
 * para os modelos que não definem o seu próprio corte. Editável em
 * Configurações → Frequência, então lido a cada chamada.
 */
function ausenteDiasPadrao() {
  const n = Number(config.ler().frequencia.ausenteDias);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 10;
}

/** Diferença em dias entre uma data 'AAAA-MM-DD' e hoje. */
function diasDesde(iso, hoje) {
  if (!iso) return null;
  const a = Date.parse(String(iso).slice(0, 10) + 'T00:00:00Z');
  const b = Date.parse(String(hoje).slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.floor((b - a) / 86400000);
}

/**
 * Se este aluno conta como sumido.
 *
 * NUNCA TER TREINADO NÃO É O MESMO QUE TER SUMIDO
 *   Quem tem check-in é fácil: conta os dias desde o último. O problema é
 *   quem nunca apareceu — antes, essa pessoa entrava sempre, e o aluno
 *   matriculado ontem, que ainda não passou o QR uma vez, recebia "sentimos
 *   sua falta" no dia seguinte. Para quem nunca treinou, o relógio começa na
 *   matrícula: `desde` quando existe, senão o dia em que a ficha foi criada.
 *   Assim a carência é a mesma para todo mundo, e o aluno novo só entra se
 *   realmente passar o período sem aparecer nenhuma vez.
 *
 *   Ficha sem nenhuma das duas datas entra: é cadastro antigo, não aluno novo.
 */
function sumiu(a, limite, teto, ficha, hoje) {
  let d = (a.diasSemTreinar !== null && a.diasSemTreinar !== undefined)
    ? a.diasSemTreinar
    : diasDesde(
      ficha ? (ficha.desde || String(ficha.criadoEm || '').slice(0, 10) || null) : null,
      hoje);

  // Sem check-in e sem data de início não dá para saber há quanto tempo a
  // pessoa sumiu. Sem teto isso entra, como sempre entrou. Com teto, fica de
  // fora: o teto existe justamente para não escrever para quem já foi embora,
  // e chutar aqui desfaz a proteção.
  if (d === null) return !teto;

  if (d < limite) return false;
  // TETO: QUEM SUMIU DEMAIS PROVAVELMENTE SAIU
  //   O sistema não sabe a diferença entre "faltou três semanas" e "cancelou e
  //   não avisou". Passado o teto, a hipótese mais provável é a segunda, e
  //   "sentimos sua falta" para quem saiu há cinco meses é constrangedor.
  //   Essa pessoa vira assunto de conversa, não de disparo automático.
  return teto ? d <= teto : true;
}

/**
 * Finais de telefone (8 dígitos) que já entraram no app.
 *
 * A ficha de acesso só nasce no `/entrar`, então ela existir É a prova de que a
 * pessoa abriu o app pelo menos uma vez. Comparar pelos 8 últimos dígitos é o
 * mesmo critério da aba Matrículas: o mesmo número aparece ora com o 55 na
 * frente, ora sem o nono dígito, e exigir igualdade literal faria a pessoa
 * receber "baixe o app" depois de já estar dentro dele.
 */
function finaisComAcesso() {
  const finais = new Set();
  for (const a of alunosLogin.listarAlunos()) {
    const d = String(a.telefone || '').replace(/\D/g, '');
    if (d.length >= 8) finais.add(d.slice(-8));
  }
  return finais;
}

/** Primeiro nome, que é como se fala com o aluno no WhatsApp. */
function primeiroNome(nome) {
  return String(nome || '').trim().split(/\s+/)[0] || '';
}

/**
 * Índice matriculaId → situação de frequência, para preencher {{mesRealizado}}
 * e {{mesEsperado}} mesmo quando o público não é "devedores". Avalia todo
 * mundo (`vinculo: null`), porque um mensalista também recebe mensagem.
 */
function indiceDeFrequencia() {
  const mapa = new Map();
  try {
    const painel = alertas.montarPainel({ vinculo: presencas.vinculoParaPainel() });
    for (const a of painel.alunos) mapa.set(a.matriculaId, a);
  } catch (e) {
    // Frequência é enfeite aqui: se o cálculo falhar, a mensagem ainda sai —
    // só os marcadores de treino ficam vazios.
    console.log('[destinatarios] frequência indisponível:', e.message);
  }
  return mapa;
}

function ficha(m, freq) {
  const f = freq || null;
  return {
    matriculaId: m.id,
    nome: m.nome,
    primeiroNome: primeiroNome(m.nome),
    telefone: m.telefone || null,
    telefoneFormatado: m.telefone ? telefone.mostrar(telefone.normalizar(m.telefone) || m.telefone) : null,
    temTelefone: Boolean(telefone.normalizar(m.telefone)),
    vinculo: m.vinculo,
    diasSemana: Array.isArray(m.grade) ? m.grade.length : 0,
    aniversario: m.aniversario || null,
    situacao: f ? f.situacao : null,
    realizado: f ? f.realizado : null,
    esperado: f ? f.esperado : null,
    mesRealizado: f && f.mes ? f.mes.realizado : null,
    mesEsperado: f && f.mes ? f.mes.esperado : null,
    ultimoCheckin: f ? f.ultimoCheckin : null,
    // Números do fechamento do mês, que são os que a cobrança usa.
    metaDoMes: f && f.mes ? f.mes.meta : null,
    faltamNoMes: f && f.mes ? f.mes.faltam : null,
    atrasoNoRitmo: f && f.mes ? f.mes.atrasoNoRitmo : null,
    diasRestantes: f && f.mes ? f.mes.diasRestantes : null,
    diasSemTreinar: f ? f.diasSemTreinar : null,
    motivo: motivoDe(f, m),
  };
}

/**
 * Uma linha explicando por que a pessoa está na lista. Sem isto o disparo é
 * uma lista de nomes sem contexto, e conferir antes de enviar significaria
 * abrir a aba Frequência em paralelo, aluno por aluno.
 */
const ROTULO = {
  critico: 'crítico', atrasado: 'atrasado', 'em-dia': 'em dia',
  quitado: 'pacote fechado', 'sem-aula': 'sem aula prevista',
  'sem-grade': 'sem grade', experimental: 'experimental',
};

function motivoDe(f, m) {
  // Sem ficha de frequência não é falha de cálculo: é o mensalista, que não
  // tem fonte de presença. Dizer isso é melhor do que um traço no lugar.
  if (!f) {
    return m && m.vinculo === 'mensalista'
      ? 'mensalista · sem registro de presença'
      : 'sem dados de frequência';
  }
  const partes = [ROTULO[f.situacao] || f.situacao];
  if (f.mes && f.mes.meta) partes.push(`${f.mes.realizado}/${f.mes.esperado} no mês`);
  if (f.ultimoCheckin) {
    partes.push('último em ' + f.ultimoCheckin.split('-').reverse().slice(0, 2).join('/'));
  } else {
    partes.push('sem check-in');
  }
  return partes.join(' · ');
}

/**
 * @param {string} publico  todos | wellhub | mensalista | devedores | ausentes
 *                           | sem_app
 * @param {object} opcoes   { aniversarioEm, ausenteDias, ausenteAte }
 */
function montar(publico = 'todos', opcoes = {}) {
  const freq = indiceDeFrequencia();
  // Corte de ausência do modelo, quando ele define um; senão o padrão do
  // estúdio. Fica aqui, e não no agendador, para a prévia da tela e o disparo
  // automático chegarem à mesma lista.
  const limiteAusente = Number(opcoes.ausenteDias) > 0
    ? Math.round(Number(opcoes.ausenteDias)) : ausenteDiasPadrao();
  const tetoAusente = Number(opcoes.ausenteAte) > 0
    ? Math.round(Number(opcoes.ausenteAte)) : 0;
  let lista;

  if (publico === 'devedores' || publico === 'ausentes') {
    // SÓ WELLHUB, POR REGRA DE NEGÓCIO
    //   O repasse do Wellhub depende do check-in: quem não passa no portal é
    //   aula que o estúdio não recebe, e é isso que estes públicos cobram. O
    //   mensalista já pagou, venha ou não — a presença dele no totem é
    //   acompanhamento (Lista do dia), nunca cobrança. Ver `presencas.js`.
    const painel = alertas.montarPainel({ vinculo: presencas.vinculoParaPainel() });

    const todas = matriculas.listar();
    let ids;

    if (publico === 'devedores') {
      ids = new Set(frequencia.devedores(painel).map((a) => a.matriculaId));
    } else {
      // Ausente é outra pergunta: não "está atrás da meta", e sim "sumiu".
      // Quem treina 1× por semana pode estar em dia com o pacote e não
      // aparecer há três semanas — e é essa pessoa que se perde sem ninguém
      // notar.
      const fichas = new Map(todas.map((m) => [m.id, m]));
      const hoje = frequencia.hojeLocal();
      ids = new Set(painel.alunos
        .filter((a) => a.situacao !== 'experimental' && a.situacao !== 'sem-grade')
        .filter((a) => sumiu(a, limiteAusente, tetoAusente, fichas.get(a.matriculaId), hoje))
        .map((a) => a.matriculaId));
    }

    lista = todas.filter((m) => m.ativo && ids.has(m.id));
  } else {
    // SEM TELEFONE FICA DE FORA DESTE PÚBLICO, E SÓ DESTE
    //   Nos outros, quem não tem número entra na lista marcado como "sem
    //   telefone": é informação sua, e some da tela seria pior. Aqui não: o
    //   público inteiro existe para convidar gente para o app por WhatsApp, e
    //   sem número não há convite a mandar — a pessoa só engrossaria a contagem
    //   e o total da tela deixaria de dizer quantas mensagens vão sair.
    const comAcesso = publico === 'sem_app' ? finaisComAcesso() : null;
    lista = matriculas.listar().filter((m) => {
      if (!m.ativo) return false;
      if (publico === 'wellhub') return m.vinculo === 'wellhub';
      if (publico === 'mensalista') return m.vinculo === 'mensalista';
      if (publico === 'sem_app') {
        const d = String(m.telefone || '').replace(/\D/g, '');
        return d.length >= 8 && !comAcesso.has(d.slice(-8));
      }
      return true;
    });
  }

  const alunos = lista.map((m) => ficha(m, freq.get(m.id)));

  // O motivo da linha é o que faz a conferência antes do disparo valer alguma
  // coisa. Neste público a frequência não diz nada de útil — o que importa é
  // que a pessoa nunca abriu o app.
  if (publico === 'sem_app') {
    for (const a of alunos) a.motivo = 'nunca entrou no app';
  }

  // Aniversariantes do dia: filtro extra, aplicado sobre qualquer público.
  const filtrados = opcoes.aniversarioEm
    ? alunos.filter((a) => a.aniversario === opcoes.aniversarioEm)
    : alunos;

  return {
    publico,
    total: filtrados.length,
    comTelefone: filtrados.filter((a) => a.temTelefone).length,
    semTelefone: filtrados.filter((a) => !a.temTelefone).length,
    alunos: filtrados.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')),
  };
}

/**
 * Troca os {{marcadores}} pelos valores do aluno. Marcador desconhecido vira
 * string vazia — o mesmo comportamento de `mensageiro.preencher`, para o texto
 * escrito na tela se comportar igual no envio manual e no programado.
 */
function dataCurta(iso) {
  return iso ? iso.split('-').reverse().slice(0, 2).join('/') : '';
}

function preencher(texto, aluno, extras = {}) {
  const valores = {
    /* --- nomes atuais, os que a tela oferece --- */
    nome: aluno.primeiroNome,
    nomeCompleto: aluno.nome,
    treinosNoMes: aluno.mesRealizado,
    metaDoMes: aluno.metaDoMes,
    treinosQueFaltam: aluno.faltamNoMes,
    treinosAtrasados: aluno.atrasoNoRitmo,
    treinosPorSemana: aluno.diasSemana,
    diasSemTreinar: aluno.diasSemTreinar,
    ultimoTreino: dataCurta(aluno.ultimoCheckin),
    diasAteFimDoMes: aluno.diasRestantes,
    plano: aluno.vinculo === 'wellhub' ? 'Wellhub' : 'mensalista',

    /* --- NOMES ANTIGOS, MANTIDOS DE PROPÓSITO ---
       Modelos escritos antes desta troca continuam no ar. Tirar estas chaves
       faria a mensagem sair com um buraco no lugar do número, e o aluno é que
       receberia o texto quebrado. Não aparecem mais na lista da tela. */
    vinculo: aluno.vinculo === 'wellhub' ? 'Wellhub' : 'mensalista',
    diasSemana: aluno.diasSemana,
    realizado: aluno.realizado,
    esperado: aluno.esperado,
    mesRealizado: aluno.mesRealizado,
    mesEsperado: aluno.mesEsperado,

    ...extras,
  };
  // Marcador é o que a pessoa digita, e ninguém lembra da caixa certa no meio
  // de um texto longo. {{NOME}} sumindo da mensagem é pior que um erro visível:
  // o aluno recebe "Olá, !" e ninguém percebe até ele responder.
  const porNomeSimples = new Map(
    Object.keys(valores).map((k) => [k.toLowerCase(), k]));

  return String(texto || '').replace(/\{\{(\w+)\}\}/g, (_, chave) => {
    const real = porNomeSimples.get(String(chave).toLowerCase());
    const valor = real === undefined ? undefined : valores[real];
    return valor === undefined || valor === null ? '' : String(valor);
  });
}

/** Lista dos marcadores, para a tela oferecer os botões de inserir. */
/**
 * O que a tela oferece. A descrição é o texto que o marcador substitui, não o
 * nome técnico do campo: quem escreve a mensagem precisa saber o que vai
 * aparecer para o aluno, e `mesEsperado` não dizia isso a ninguém.
 */
const MARCADORES = [
  { chave: 'nome', descricao: 'Primeiro nome — "Ana"', exemplo: 'Ana' },
  { chave: 'nomeCompleto', descricao: 'Nome completo — "Ana Souza"', exemplo: 'Ana Souza' },
  { chave: 'treinosNoMes', descricao: 'Quantos treinos já fez este mês', exemplo: '4' },
  { chave: 'metaDoMes', descricao: 'Quantos treinos o pacote dele prevê no mês', exemplo: '12' },
  { chave: 'treinosQueFaltam', descricao: 'Quantos ainda faltam para fechar o mês', exemplo: '8' },
  { chave: 'treinosAtrasados', descricao: 'Quantos está atrás do ritmo combinado', exemplo: '2' },
  { chave: 'treinosPorSemana', descricao: 'Quantas vezes por semana ele combinou treinar', exemplo: '3' },
  { chave: 'diasSemTreinar', descricao: 'Há quantos dias não aparece', exemplo: '9' },
  { chave: 'ultimoTreino', descricao: 'Data do último treino — "18/08"', exemplo: '18/08' },
  { chave: 'diasAteFimDoMes', descricao: 'Quantos dias ainda restam no mês', exemplo: '11' },
  { chave: 'plano', descricao: 'Wellhub ou mensalista', exemplo: 'Wellhub' },
];

/**
 * Ficha de um aluno só, pelo mesmo caminho que gera a prévia da tela.
 *
 * Existe para o envio individual poder preencher os marcadores no servidor.
 * Refazer a montagem da ficha aqui daria uma segunda versão dos mesmos campos,
 * e é assim que a prévia e a mensagem enviada acabam divergindo.
 */
function porMatricula(matriculaId) {
  if (!matriculaId) return null;
  return montar('todos').alunos.find((a) => a.matriculaId === matriculaId) || null;
}

module.exports = { montar, porMatricula, preencher, primeiroNome, MARCADORES };
