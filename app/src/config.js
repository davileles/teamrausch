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
    permitirCancelar: true,
    minutosParaCancelar: 120,   // até X min antes do horário
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
  // Marcos que o aluno vê na aba Meus dados. Editáveis em Configurações.
  conquistas: [
    { aulas: 1,   titulo: 'Primeira aula',  emoji: '🎉' },
    { aulas: 10,  titulo: 'Pegando o ritmo', emoji: '💪' },
    { aulas: 25,  titulo: 'Já é rotina',     emoji: '🔥' },
    { aulas: 50,  titulo: 'Meio century',    emoji: '⭐' },
    { aulas: 100, titulo: 'Cem aulas',       emoji: '🏆' },
    { aulas: 200, titulo: 'Veterano',        emoji: '👑' },
  ],
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
  atual = fundir(ler(), novo);
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

module.exports = { ler, gravar, publica, paraAdmin, DIAS, PADRAO };
