'use strict';

const fs = require('fs');
const path = require('path');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ARQUIVO = path.join(DIR, 'config.json');

const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];

/**
 * Tudo aqui é editável pela aba Configurações. Estes valores só valem na
 * primeira vez que o serviço sobe, para a tela não abrir vazia.
 */
const PADRAO = {
  estudio: {
    nome: 'Meu estúdio',
    fuso: 'America/Sao_Paulo',
    // Fica fixo no topo da aba Agendar, junto das regras geradas sozinhas.
    recado: '',
    // Aparece como popup quando a pessoa entra, uma vez por texto novo.
    alerta: '',
    alertaAte: '',   // 'AAAA-MM-DD': depois desta data o alerta some sozinho
  },
  agenda: {
    diasAntecedencia: 1,        // 0 = só hoje; 1 = hoje e amanhã; 2 = mais um dia...
    capacidadePadrao: 8,
    minutosAntesDeFechar: 30,   // fecha o horário X min antes de começar
    limitePorDia: 1,            // quantos horários a mesma pessoa pega no mesmo dia
    // As aulas fixas das matrículas ocupam lugar na agenda como qualquer
    // reserva. Desligar volta a contar só quem reservou pelo app — e a tela
    // passa a oferecer vagas que na prática já têm dono.
    contarMatriculasNaLotacao: true,
    // Ninguém reserva mais dias na semana do que a matrícula prevê. Quem não
    // tem matrícula vinculada continua sem limite semanal.
    respeitarFrequencia: true,
    permitirCancelar: true,
    minutosParaCancelar: 120,   // até X min antes do horário
    // Reposição. Desmarcar com antecedência vira um crédito na matrícula, e o
    // crédito banca uma aula extra em outro dia — inclusive além da frequência
    // contratada. Desligado, desmarcar continua desmarcando e a aula é perdida.
    creditoReposicao: true,
    // Quem concede o crédito é o estúdio: viagem avisada, atestado, dia em que
    // a sala não abriu. Desmarcar sozinho pelo app não gera crédito nenhum —
    // senão "desmarquei" viraria "ganhei uma aula", e o saldo cresceria sem
    // que ninguém tivesse decidido nada.
    creditoAutomatico: false,
    // Só vale com `creditoAutomatico` ligado: desmarcou faltando menos que
    // isto, é falta. A vaga já não dá tempo de ser reaproveitada por ninguém.
    horasParaGerarCredito: 24,
    // Prazo para usar o crédito, contado a partir da data da aula perdida.
    // 0 = não expira.
    validadeCreditoDias: 30,
    // Janela de agendamento de quem tem crédito na mão. A janela normal é
    // curta de propósito, mas reposição se marca com semanas de antecedência —
    // com 1 dia, o crédito existiria no papel e não teria onde ser gasto.
    diasAntecedenciaReposicao: 21,
    horarios: {
      dom: [],
      seg: [{ hora: '06:00' }, { hora: '07:00' }, { hora: '18:00' }, { hora: '19:00' }],
      ter: [{ hora: '06:00' }, { hora: '07:00' }, { hora: '18:00' }, { hora: '19:00' }],
      qua: [{ hora: '06:00' }, { hora: '07:00' }, { hora: '18:00' }, { hora: '19:00' }],
      qui: [{ hora: '06:00' }, { hora: '07:00' }, { hora: '18:00' }, { hora: '19:00' }],
      sex: [{ hora: '06:00' }, { hora: '07:00' }, { hora: '18:00' }],
      sab: [],
    },
    datasBloqueadas: [],        // ['2026-12-25']
  },
  /**
   * Marcos que o aluno vê na aba Meus dados e que disparam o parabéns no
   * WhatsApp. Editáveis em Configurações → Conquistas, texto incluído.
   *
   * `mensagem` aceita {{nome}}, {{conquista}}, {{aulas}}, {{emoji}},
   * {{total}}, {{proximaConquista}} e {{faltam}}. Vazia, vale
   * `conquistasAviso.mensagemPadrao` — conquista sem texto não nasce muda.
   */
  conquistas: [
    { aulas: 1, titulo: 'Primeira aula', emoji: '🎉',
      mensagem: '🎉 *Primeira aula concluída!*\n\n{{nome}}, você começou — e começar é a parte que a maioria adia.\n\nTe esperamos no próximo horário. É o segundo treino que transforma isso em rotina. 💪' },
    { aulas: 10, titulo: 'Pegando o ritmo', emoji: '💪',
      mensagem: '💪 *10 aulas!*\n\n{{nome}}, dez treinos no corpo. A respiração e a disposição já estão diferentes do primeiro dia.\n\nDaqui pra frente o corpo começa a cobrar quando você falta. Isso é bom sinal.' },
    { aulas: 25, titulo: 'Já é rotina', emoji: '🔥',
      mensagem: '🔥 *25 aulas — já é rotina!*\n\n{{nome}}, 25 treinos não é empolgação de começo. É hábito.\n\nVocê passou da fase em que a maioria para. Orgulho de ter você aqui.' },
    { aulas: 50, titulo: 'Meio century', emoji: '⭐',
      mensagem: '⭐ *50 aulas!*\n\n{{nome}}, meio century. Cinquenta vezes que você escolheu vir treinar em vez de deixar pra depois.\n\nCompara com o seu primeiro dia. Essa diferença é sua.' },
    { aulas: 100, titulo: 'Cem aulas', emoji: '🏆',
      mensagem: '🏆 *100 aulas!*\n\n{{nome}}, três casas. Cem treinos.\n\nIsso não se compra nem se acelera — só se constrói aparecendo. Pra quem está começando agora, você é a referência.\n\nPassa aqui na recepção que tem uma coisinha te esperando. 😉' },
    { aulas: 200, titulo: 'Veterano', emoji: '👑',
      mensagem: '👑 *200 aulas — Veterano!*\n\n{{nome}}, duzentos treinos. Pouquíssima gente chega aqui.\n\nVocê viu turma entrar, viu turma sair, e continuou vindo. Obrigado por fazer parte disso. 🙏' },
  ],
  /**
   * PARABÉNS AUTOMÁTICO DE CONQUISTA
   *
   * Sai à noite, depois da última aula: ninguém quer receber parabéns às 6h da
   * manhã, e o aluno que treinou às 19h precisa estar contado antes do envio.
   * A conta de aulas é a de `historico-aulas.js` — presença no tablet ou
   * check-in do Wellhub, um dia conta uma vez.
   */
  conquistasAviso: {
    ativo: true,
    hora: '20:30',
    avisarGrupo: true,          // resumo do que saiu para as listas do estúdio
    mensagemPadrao: '{{emoji}} *{{conquista}}!*\n\n{{nome}}, você acabou de fechar {{aulas}} aulas no estúdio. Continua vindo. 💪',
  },
  /**
   * AGRADECIMENTO PELA META DO MÊS
   *
   * Aluno Wellhub que fecha os check-ins combinados no mês (2x/semana = 8,
   * 3x/semana = 12) recebe um obrigado no WhatsApp. Sai uma vez por aluno por
   * mês, à noite, depois das conquistas. `mensagem` vazia usa o texto padrão
   * de `meta-mensal-mensagens.js`. Marcadores: {{nome}}, {{nomeCompleto}},
   * {{meta}}, {{realizado}}, {{porSemana}}, {{mes}} e {{estudio}}.
   */
  metaMensalAviso: {
    ativo: true,
    hora: '20:45',
    avisarGrupo: true,
    mensagem: '',
  },
  /**
   * TABLET DA ENTRADA
   *
   * Quanto tempo ao redor do horário da aula a confirmação de presença vale.
   * Era `TOTEM_MINUTOS_ANTES` / `TOTEM_MINUTOS_DEPOIS` no Railway — virou
   * configuração pelo mesmo motivo dos valores de frequência: é regra de
   * estúdio, não infraestrutura, e mudar não deveria pedir deploy. As
   * variáveis antigas não são mais lidas; podem sair do Railway.
   */
  totem: {
    minutosAntes: 20,           // confirmação liberada X min antes da aula
    minutosDepois: 20,          // e ainda aceita até X min depois de começar
  },
  /**
   * MURAL DA TV
   *
   * A TV do estúdio (Chromecast) roda `/tv.html`, que gira aniversariantes do
   * dia, conquistas de hoje e ontem e os avisos abaixo. O aviso em destaque do
   * app (`estudio.alerta`) entra sozinho — não precisa repetir aqui.
   *
   * `castAppId` é o ID do receptor registrado no Google Cast Developer
   * Console. Vazio, o botão "Ligar TV" não aparece no tablet.
   */
  mural: {
    ativo: true,
    segundosPorSlide: 12,
    avisos: [],                 // [{ texto, de: 'AAAA-MM-DD', ate: 'AAAA-MM-DD' }]
    castAppId: '',
  },
  acesso: {
    // Senha do administrador. Guardamos só o hash com sal, nunca o texto.
    // null = administrador entra por código, como qualquer aluno.
    senhaAdmin: null,
    diasDeSessao: 7,
    canalDoCodigo: 'log',       // log | whatsapp | sms
    minutosDeValidadeDoCodigo: 10,
    maxPedidosPorHora: 5,
    maxTentativas: 5,
    cadastroAberto: true,       // false = só telefones já cadastrados entram
  },
  envio: {
    // Um POST HTTP serve para o serviço de WhatsApp deste repositório e para
    // qualquer provedor de SMS. Use {{telefone}} e {{mensagem}} no corpo.
    url: process.env.WHATSAPP_URL || '',
    token: process.env.WHATSAPP_TOKEN || '',
    nomeDoCabecalhoDoToken: 'Authorization',
    corpo: '{"telefone":"{{telefone}}","mensagem":"{{mensagem}}"}',
    texto: 'Seu código de acesso é {{codigo}}. Vale por {{minutos}} minutos.',
  },
  /**
   * Repasse do Wellhub por check-in validado, separado por produto.
   *
   * O portal manda o produto em `product.description` — hoje "Funcional" e
   * "Crosstraining" — e cada um paga um valor diferente. Sem estes dois números
   * a aba Mês sabe contar treinos e não sabe dizer quanto o mês vale.
   *
   * Editável em Configurações → Negócio. Os valores abaixo só valem na primeira
   * vez que o serviço sobe: reajuste de contrato se faz na tela, não aqui.
   */
  financeiro: {
    valorFuncional: 18.75,
    valorCrosstraining: 22.28,
  },
  /**
   * FREQUÊNCIA E COBRANÇA
   *
   * Estes valores eram variáveis de ambiente. Viraram configuração porque são
   * regra de negócio, não infraestrutura: mudar de quantos dias alguém conta
   * como sumido não deveria pedir acesso ao Railway nem um deploy. As variáveis
   * antigas continuam valendo como valor inicial — quem já as tinha definidas
   * não vê diferença até editar na tela, e a partir daí a tela manda.
   */
  frequencia: {
    // Cobrança é só Wellhub e só por check-in. A presença do totem é gestão
    // (Lista do dia) e não tem chave aqui — ver `presencas.js`.
    // Dias sem aparecer a partir dos quais o aluno entra no público "Sumidos".
    // Cada modelo de mensagem pode ter o seu; este é o valor de quem não tem.
    ausenteDias: Number(process.env.PRESENCA_AUSENTE_DIAS || 10),
    // Aviso diário de quem está atrás da meta. Vai para as listas do estúdio,
    // nunca para o aluno.
    alertaAtivo: String(process.env.FREQ_ALERTA_ATIVO || 'true') === 'true',
    alertaHora: String(process.env.FREQ_ALERTA_HORA || '10:00'),
    janelaDias: Number(process.env.FREQ_JANELA_DIAS || 7),
    // 0=dom … 6=sáb. Dias em que o aviso sai.
    alertaDias: String(process.env.FREQ_ALERTA_DIAS || '1,2,3,4,5')
      .split(',').map((x) => Number(String(x).trim()))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6),
    // Texto padrão do botão de cobrar um aluno pela tela de Frequência.
    textoCobranca: String(process.env.FREQ_TEXTO_COBRANCA
      || 'Oi, {{nome}}! Aqui é do TeamRausch. Neste mês você fez {{mesRealizado}} '
       + 'de {{mesEsperado}} treinos combinados. Consegue repor essa semana? '
       + 'Se precisar remarcar horário, é só falar com a gente.'),
  },
  /** Disparo automático dos modelos programados e recorrentes. */
  mensagens: {
    agendadorAtivo: String(process.env.MSG_AGENDADOR_ATIVO || 'true') === 'true',
    // Pausa entre um aluno e o próximo. Rajada é o que mais derruba número.
    pausaSegundos: Math.round(Number(process.env.MSG_PAUSA_MS || 8000) / 1000),
    // Quanto tempo depois da hora marcada um envio programado ainda vale.
    toleranciaMin: Number(process.env.MSG_TOLERANCIA_MIN || 720),
    // Nomes no aviso ao grupo antes de virar parede de texto.
    avisoMaxLinhas: Number(process.env.MSG_AVISO_MAX_LINHAS || 25),
  },
  // Quem recebe os avisos de operação (e-mail e/ou WhatsApp).
  // Editável em Configurações → Avisos. Sem e-mail cadastrado o sistema cai no
  // WELLHUB_ALERTA_EMAIL.
  avisos: {
    emails: [],                 // ['fulano@estudio.com', 'recepcao@estudio.com']
    // Mantida por compatibilidade com configs antigos: nenhum aviso automático
    // sai para telefone. No WhatsApp, o destino é o grupo — ver `grupos`.
    telefones: [],
    // Grupos do WhatsApp que recebem os avisos — o "grupo do operador" do
    // estúdio. JIDs completos: ['120363411741796601@g.us']. É o único destino
    // do canal WhatsApp: lista vazia = canal desligado.
    grupos: [],
  },
  administradores: [],          // telefones em E.164: ['5531988887777']
};

let atual = null;

function fundir(base, novo) {
  // null é um valor deliberado ("apague isto"), não ausência. Sem esta linha
  // ele cairia no laço abaixo e o objeto antigo sobreviveria — foi assim que
  // remover a senha do administrador não removia nada.
  if (novo === null) return null;
  if (Array.isArray(base) || typeof base !== 'object' || base === null) {
    return novo === undefined ? base : novo;
  }
  const saida = { ...base };
  for (const chave of Object.keys(novo || {})) {
    saida[chave] = fundir(base[chave], novo[chave]);
  }
  return saida;
}

/** Aceita 31988887777 ou 5531988887777 e devolve E.164. */
function telefoneSimples(entrada) {
  let n = String(entrada || '').replace(/\D/g, '');
  if (n.startsWith('55') && n.length === 13) n = n.slice(2);
  return n.length === 11 ? '55' + n : null;
}

/**
 * Chaves que saíram do sistema e não devem sobreviver num config.json antigo.
 *
 * `frequencia.confirmacaoAtiva` somava a presença do totem à cobrança — o que
 * punha o mensalista (que já pagou) entre os devedores e escondia o check-in
 * esquecido do Wellhub. A presença do totem agora é só gestão (`presencas.js`).
 * Limpa na leitura e na gravação, para não reaparecer na tela nem voltar ao
 * disco no próximo salvar.
 */
function semChavesRemovidas(c) {
  if (c && c.frequencia) delete c.frequencia.confirmacaoAtiva;
  return c;
}

/**
 * Conquista salva antes deste recurso não tem o campo `mensagem`, e `fundir`
 * troca array inteiro por array inteiro — sem isto os textos de fábrica não
 * chegariam a quem já tinha configurado a lista. Só preenche quando a chave
 * está AUSENTE: texto apagado de propósito na tela chega como string vazia e
 * continua vazio, senão apagar não apagaria nada.
 */
function comTextosDeFabrica(c) {
  if (!c || !Array.isArray(c.conquistas)) return c;
  const fabrica = new Map(PADRAO.conquistas.map((m) => [Number(m.aulas), m.mensagem]));
  for (const m of c.conquistas) {
    if (m && m.mensagem === undefined && fabrica.has(Number(m.aulas))) {
      m.mensagem = fabrica.get(Number(m.aulas));
    }
  }
  return c;
}

function ler() {
  if (atual) return atual;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    atual = fs.existsSync(ARQUIVO)
      ? fundir(PADRAO, JSON.parse(fs.readFileSync(ARQUIVO, 'utf8')))
      : { ...PADRAO };
  } catch (erro) {
    console.error('[config] não consegui ler, usando os padrões:', erro.message);
    atual = { ...PADRAO };
  }

  semChavesRemovidas(atual);
  comTextosDeFabrica(atual);

  // Sem administrador ninguém abre a aba de configurações. Este é o primeiro.
  if (!atual.administradores.length && process.env.ADMIN_INICIAL) {
    const tel = telefoneSimples(process.env.ADMIN_INICIAL);
    if (tel) {
      atual.administradores = [tel];
      console.log('[config] administrador inicial definido:', tel);
    } else {
      console.error('[config] ADMIN_INICIAL inválido, use DDD + 9 dígitos.');
    }
  }
  return atual;
}

function gravar(novo) {
  atual = semChavesRemovidas(fundir(ler(), novo));
  fs.mkdirSync(DIR, { recursive: true });
  const temp = `${ARQUIVO}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(atual, null, 2));
  fs.renameSync(temp, ARQUIVO);
  return atual;
}

/** Versão sem segredos, para telas que não são de administrador. */
function publica() {
  const c = ler();
  return {
    estudio: c.estudio,
    agenda: {
      diasAntecedencia: c.agenda.diasAntecedencia,
      permitirCancelar: c.agenda.permitirCancelar,
      minutosParaCancelar: c.agenda.minutosParaCancelar,
      limitePorDia: c.agenda.limitePorDia,
      respeitarFrequencia: c.agenda.respeitarFrequencia !== false,
      creditoReposicao: c.agenda.creditoReposicao !== false,
      creditoAutomatico: c.agenda.creditoAutomatico === true,
      horasParaGerarCredito: c.agenda.horasParaGerarCredito,
      validadeCreditoDias: c.agenda.validadeCreditoDias,
      diasAntecedenciaReposicao: c.agenda.diasAntecedenciaReposicao,
    },
  };
}

/**
 * Config para a tela de administração: igual à real, mas sem o hash da senha.
 * O hash não serve para nada no navegador e, exposto, vira alvo de quebra
 * offline.
 */
function paraAdmin() {
  const c = ler();
  return {
    ...c,
    acesso: { ...c.acesso, senhaAdmin: undefined, temSenhaAdmin: Boolean(c.acesso.senhaAdmin) },
  };
}

/**
 * Telefone (E.164) está na lista de administradores.
 *
 * Mora aqui porque a lista mora aqui: quando a gestão de acesso passou da aba
 * Alunos para a matrícula, dois arquivos de rota passaram a precisar da mesma
 * resposta, e uma segunda cópia da comparação acabaria divergindo.
 */
function ehAdmin(telefone) {
  return (ler().administradores || []).includes(telefone);
}

module.exports = { ler, gravar, publica, paraAdmin, ehAdmin, DIAS, PADRAO };
