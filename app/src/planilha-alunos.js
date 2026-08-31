'use strict';

/**
 * app/src/planilha-alunos.js — davileles/teamrausch
 *
 * Cadastro dos alunos por planilha do Google, lida uma vez por dia.
 *
 * A secretaria preenche uma linha por aluno numa planilha compartilhada e o
 * serviço se serve dela sozinho. Não há upload, endpoint de importação manual
 * nem passo de conversão: a planilha É a porta de entrada do cadastro.
 *
 * Por que CSV e não a API do Google:
 *   A API exigiria conta de serviço, chave em variável e uma dependência nova
 *   no projeto. Uma planilha compartilhada como "qualquer pessoa com o link"
 *   responde CSV num GET simples, que o `fetch` do Node resolve sem biblioteca.
 *   Como só se LÊ, e os dados são nome/telefone/horário do próprio estúdio, a
 *   troca é boa — mas vale lembrar que quem tiver o link lê a planilha.
 *
 * O que a sincronização NÃO faz:
 *   Nunca apaga ninguém. Aluno que some da planilha continua na base — desligar
 *   alguém é decisão de gente, feita na coluna Ativo ou pelo painel. Isto a
 *   separa de `matriculas-store.importar`, que troca a base inteira.
 *
 * Variáveis:
 *   PLANILHA_ALUNOS_URL    link da planilha (o link normal de compartilhamento serve)
 *   PLANILHA_ALUNOS_ABA    nome da aba lida            (padrão 'Alunos')
 *   PLANILHA_ALUNOS_HORA   horário da leitura diária   (padrão '05:00')
 *   PLANILHA_ALUNOS_ATIVO  'false' desliga o agendador (padrão: ligado se houver URL)
 */

const matriculas = require('./matriculas-store');

const URL_BRUTA = String(process.env.PLANILHA_ALUNOS_URL || '').trim();
const ABA = String(process.env.PLANILHA_ALUNOS_ABA || 'Alunos').trim();
const HORA = String(process.env.PLANILHA_ALUNOS_HORA || '05:00').trim();
const ATIVO = URL_BRUTA
  && String(process.env.PLANILHA_ALUNOS_ATIVO || 'true') !== 'false';

const estado = {
  ultimaData: null,      // 'YYYY-MM-DD' da última execução automática
  ultimaRodadaEm: null,
  ultimoResumo: null,
  ultimoErro: null,
};

function log(...a) { console.log('[planilha-alunos]', ...a); }

/* ------------------------------- endereço -------------------------------- */

/**
 * Transforma o link de compartilhamento no endereço que devolve CSV.
 *
 * O link que a pessoa copia do navegador termina em `/edit#gid=0` e responde
 * HTML. Pedir para ela montar a URL de exportação à mão é pedir para dar
 * errado, então a conversão é feita aqui.
 */
function enderecoCsv(url = URL_BRUTA) {
  const bruto = String(url || '').trim();
  if (!bruto) return null;

  // Já é um endereço de exportação (montado à mão ou publicado na web).
  if (/output=csv|format=csv|out:csv/i.test(bruto)) return bruto;

  // Planilha publicada em Arquivo → Publicar na web, sem o parâmetro de formato.
  if (bruto.includes('/spreadsheets/d/e/')) {
    const base = bruto.split('#')[0].split('?')[0];
    return `${base.replace(/\/(edit|view|pubhtml|pub)$/, '/pub')}?output=csv`;
  }

  const m = bruto.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!m) return bruto;   // endereço fora do padrão: tenta como veio
  return `https://docs.google.com/spreadsheets/d/${m[1]}`
    + `/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(ABA)}`;
}

/* --------------------------------- CSV ----------------------------------- */

/**
 * Leitor de CSV. Só precisa dar conta do que o Google gera: aspas duplas,
 * aspas escapadas por duplicação e quebra de linha dentro do campo.
 */
function lerCsv(texto) {
  const linhas = [];
  let campo = '';
  let linha = [];
  let dentroDeAspas = false;

  const conteudo = String(texto || '').replace(/^\uFEFF/, '');

  for (let i = 0; i < conteudo.length; i += 1) {
    const c = conteudo[i];

    if (dentroDeAspas) {
      if (c === '"') {
        if (conteudo[i + 1] === '"') { campo += '"'; i += 1; }
        else dentroDeAspas = false;
      } else campo += c;
      continue;
    }

    if (c === '"') { dentroDeAspas = true; continue; }
    if (c === ',') { linha.push(campo); campo = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { linha.push(campo); linhas.push(linha); linha = []; campo = ''; continue; }
    campo += c;
  }
  if (campo !== '' || linha.length) { linha.push(campo); linhas.push(linha); }

  return linhas;
}

/* ------------------------------ cabeçalho -------------------------------- */

/** Sem acento, sem asterisco, minúsculo — para casar 'Aniversário' com 'aniversario'. */
function chave(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\*/g, '')
    .trim().toLowerCase().replace(/\s+/g, ' ');
}

const DIAS = {
  domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6,
};

const CAMPOS = {
  'nome completo': 'nome',
  nome: 'nome',
  aniversario: 'aniversario',
  'aniversario (dd/mm)': 'aniversario',
  nascimento: 'aniversario',
  telefone: 'telefone',
  'telefone (whatsapp)': 'telefone',
  whatsapp: 'telefone',
  vinculo: 'vinculo',
  ciclo: 'ciclo',
  'dia vencimento': 'diaVencimento',
  'dia de vencimento': 'diaVencimento',
  vencimento: 'diaVencimento',
  ativo: 'ativo',
  inicio: 'vigenteDe',
  'inicio (aaaa-mm-dd)': 'vigenteDe',
};

/**
 * Acha a linha de cabeçalho e monta o mapa coluna → campo.
 *
 * Procurar a linha em vez de assumir a primeira deixa a planilha sobreviver a
 * um título ou a uma linha em branco colocada por quem edita, sem que a
 * sincronização quebre em silêncio.
 */
function mapearColunas(linhas) {
  for (let i = 0; i < Math.min(linhas.length, 10); i += 1) {
    const celulas = linhas[i].map(chave);
    if (!celulas.some((c) => c === 'nome' || c === 'nome completo')) continue;

    const mapa = {};
    celulas.forEach((c, col) => {
      if (CAMPOS[c]) mapa[col] = { tipo: 'campo', nome: CAMPOS[c] };
      else if (DIAS[c] !== undefined) mapa[col] = { tipo: 'dia', dia: DIAS[c] };
    });
    return { linhaCabecalho: i, mapa };
  }
  return { linhaCabecalho: -1, mapa: {} };
}

/* ------------------------------ conversões ------------------------------- */

/**
 * Horários de um dia. O Google devolve o que a pessoa digitou, e ela digita de
 * tudo: '18h', '6', '06:00 e 18:00', '18:00/19:00'. Tudo vira hora cheia.
 */
function horarios(texto) {
  const bruto = String(texto || '').trim();
  if (!bruto) return [];

  const saida = [];
  for (const pedaco of bruto.split(/[,;/|]| e /i)) {
    const m = pedaco.trim().match(/^(\d{1,2})\s*(?::|h|hs)?\s*(\d{2})?/i);
    if (!m) continue;
    const h = Number(m[1]);
    if (!Number.isInteger(h) || h < 0 || h > 23) continue;
    saida.push(`${String(h).padStart(2, '0')}:00`);
  }
  return saida;
}

/**
 * Aniversário no formato que o store espera (dia/mês).
 *
 * O Sheets adora transformar '07/03' em data e devolver o ano junto. Como o
 * cadastro não guarda ano, ele é descartado aqui em vez de fazer a validação
 * recusar a linha inteira.
 */
function aniversario(texto) {
  const bruto = String(texto || '').trim();
  if (!bruto) return '';

  const iso = bruto.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (iso) return `${iso[3]}/${iso[2]}`;

  const partes = bruto.split(/[/\-.]/).map((p) => p.trim()).filter(Boolean);
  if (partes.length >= 2) return `${partes[0]}/${partes[1]}`;
  return bruto;
}

/** Sim/Não em suas muitas formas. Célula vazia devolve undefined: não mexe no campo. */
function simNao(texto) {
  const c = chave(texto);
  if (!c) return undefined;
  if (['sim', 's', 'x', 'true', '1', 'ativo'].includes(c)) return true;
  if (['nao', 'n', 'false', '0', 'inativo'].includes(c)) return false;
  return undefined;
}

function apenasDigitos(texto) {
  return String(texto || '').replace(/\D/g, '');
}

/* ------------------------------- leitura --------------------------------- */

/**
 * Baixa a planilha e devolve uma lista de fichas prontas para o store.
 *
 * `temGrade` diz se ALGUMA célula de dia estava preenchida. Sem essa marca, uma
 * planilha em que a grade ainda não foi montada apagaria o horário de todo
 * mundo na primeira sincronização.
 */
async function baixar() {
  const alvo = enderecoCsv();
  if (!alvo) return { ok: false, motivo: 'PLANILHA_ALUNOS_URL não configurada.' };

  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), 20000);
  let resposta;
  try {
    resposta = await fetch(alvo, { signal: controle.signal, redirect: 'follow' });
  } catch (erro) {
    return { ok: false, motivo: `Não consegui baixar a planilha: ${erro.message}` };
  } finally {
    clearTimeout(relogio);
  }

  if (!resposta.ok) {
    return {
      ok: false,
      motivo: `A planilha respondeu ${resposta.status}. Confirme se ela está `
        + 'compartilhada como "qualquer pessoa com o link".',
    };
  }

  const texto = await resposta.text();
  // Sem permissão, o Google devolve a página de login com status 200. Sem esta
  // checagem, o parser leria HTML e concluiria "planilha vazia".
  if (/^\s*</.test(texto)) {
    return {
      ok: false,
      motivo: 'A planilha respondeu HTML em vez de CSV — normalmente é permissão. '
        + 'Compartilhe como "qualquer pessoa com o link".',
    };
  }

  const linhas = lerCsv(texto);
  const { linhaCabecalho, mapa } = mapearColunas(linhas);
  if (linhaCabecalho < 0) {
    return { ok: false, motivo: 'Não achei a coluna "Nome completo" no cabeçalho da planilha.' };
  }

  const fichas = [];
  const recusadas = [];

  for (let i = linhaCabecalho + 1; i < linhas.length; i += 1) {
    const linha = linhas[i];
    if (!linha.some((c) => String(c || '').trim())) continue;   // linha em branco

    const ficha = { grade: [], temGrade: false, linha: i + 1 };
    for (const [col, destino] of Object.entries(mapa)) {
      const valor = linha[Number(col)];
      if (destino.tipo === 'dia') {
        const horas = horarios(valor);
        if (String(valor || '').trim()) ficha.temGrade = true;
        for (const hora of horas) ficha.grade.push({ dia: destino.dia, hora });
      } else {
        ficha[destino.nome] = String(valor || '').trim();
      }
    }

    if (!String(ficha.nome || '').trim()) {
      recusadas.push({ linha: ficha.linha, motivo: 'sem nome' });
      continue;
    }
    ficha.aniversario = aniversario(ficha.aniversario);
    ficha.ativo = simNao(ficha.ativo);
    ficha.telefoneDigitos = apenasDigitos(ficha.telefone);
    fichas.push(ficha);
  }

  return { ok: true, fichas, recusadas, endereco: alvo };
}

/* ---------------------------- sincronização ------------------------------ */

async function rodar({ origem = 'manual', seco = false } = {}) {
  const lido = await baixar();
  if (!lido.ok) {
    estado.ultimoErro = lido.motivo;
    estado.ultimaRodadaEm = new Date().toISOString();
    return { ok: false, motivo: lido.motivo };
  }

  const r = matriculas.sincronizarPlanilha(lido.fichas, { seco });
  const resumo = {
    origem,
    seco,
    lidas: lido.fichas.length,
    criadas: r.criadas.length,
    atualizadas: r.atualizadas.length,
    semMudanca: r.semMudanca,
    recusadas: [...lido.recusadas, ...r.recusadas],
  };

  estado.ultimoResumo = resumo;
  estado.ultimoErro = null;
  estado.ultimaRodadaEm = new Date().toISOString();

  log(`${origem}${seco ? ' (simulação)' : ''}: ${resumo.lidas} linhas · `
    + `${resumo.criadas} novas · ${resumo.atualizadas} atualizadas · `
    + `${resumo.recusadas.length} recusadas.`);

  return { ok: true, ...resumo, detalhes: { criadas: r.criadas, atualizadas: r.atualizadas } };
}

/* ------------------------------ agendador -------------------------------- */

function agoraHHMM() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: process.env.TZ_ESTUDIO || 'America/Sao_Paulo',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
}

function hojeLocal() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.TZ_ESTUDIO || 'America/Sao_Paulo',
  }).format(new Date());
}

/**
 * Mesmo padrão do aviso de frequência: checa de cinco em cinco minutos se já
 * passou da hora e se ainda não rodou hoje. Esperar o minuto exato faria a
 * sincronização pular o dia sempre que o serviço estivesse reiniciando.
 */
function iniciar() {
  if (!ATIVO) {
    log(URL_BRUTA ? 'desligado (PLANILHA_ALUNOS_ATIVO=false).'
      : 'desligado — defina PLANILHA_ALUNOS_URL para ativar.');
    return;
  }
  log(`ligado: leitura diária às ${HORA}, aba "${ABA}".`);

  const tentar = async () => {
    try {
      const hoje = hojeLocal();
      if (estado.ultimaData === hoje) return;
      if (agoraHHMM() < HORA) return;
      estado.ultimaData = hoje;   // marca antes: falha de rede não vira laço
      await rodar({ origem: 'diaria' });
    } catch (e) {
      estado.ultimoErro = e.message;
      log('falhou:', e.message);
    }
  };

  setTimeout(tentar, 90000).unref?.();
  setInterval(tentar, 5 * 60000).unref();
}

function situacao() {
  return {
    ativo: Boolean(ATIVO),
    hora: HORA,
    aba: ABA,
    configurada: Boolean(URL_BRUTA),
    endereco: enderecoCsv() || null,
    ultimaData: estado.ultimaData,
    ultimaRodadaEm: estado.ultimaRodadaEm,
    ultimoResumo: estado.ultimoResumo,
    ultimoErro: estado.ultimoErro,
  };
}

module.exports = { iniciar, rodar, baixar, situacao, enderecoCsv, lerCsv, horarios };
