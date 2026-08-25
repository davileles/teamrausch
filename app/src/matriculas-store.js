'use strict';

/**
 * app/src/matriculas-store.js — davileles/teamrausch
 *
 * Cadastro interno dos alunos do estúdio, com a grade fixa de horários.
 *
 * Por que é uma base separada de `agenda-store.alunos`:
 *   `agenda-store` guarda quem faz login no app e a chave primária dele é o
 *   TELEFONE. A base que veio da planilha não tem telefone nenhum — 120 alunos
 *   identificados só pelo nome. Forçar os dois no mesmo lugar exigiria trocar a
 *   chave primária do login, mexendo em sessão, código de acesso e nas rotas
 *   `/admin/alunos/:telefone`. Aqui a chave é um `id` próprio e `telefone` é um
 *   campo opcional: quando você preencher, ele vira a ponte com o cadastro de
 *   login, sem que nada precise ser refeito.
 *
 * Persistência: arquivo próprio no volume + backup no GitHub (repo privado).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const backupGithub = require('./backup-github');
const grade = require('./grade');
const aniversario = require('./aniversario');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ARQUIVO = path.join(DIR, 'matriculas.json');
const CAMINHO_BACKUP = process.env.GITHUB_PATH_MATRICULAS || 'teamrausch/matriculas.json';
// Lista `id → telefone` mantida no repo privado. O app só LÊ este arquivo:
// serve para carregar telefones em lote (veio da aba Contatos da planilha) sem
// digitar um por um na ficha e sem expor os números no repositório público.
const CAMINHO_TELEFONES = process.env.GITHUB_PATH_TELEFONES || 'teamrausch/telefones.json';

const VINCULOS = ['wellhub', 'mensalista'];
const CICLOS = ['mensal', 'trimestral', 'semestral', 'anual'];

const backup = backupGithub.criar(CAMINHO_BACKUP, 'Matrículas do estúdio');
const fonteTelefones = backupGithub.criar(CAMINHO_TELEFONES, 'Telefones (leitura)');

let dados = { matriculas: [], excecoes: [] };
let pendente = null;
let semeando = false;

/* --------------------------- disco e backup ------------------------------ */

function carregar() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    if (fs.existsSync(ARQUIVO)) {
      const lido = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
      dados.matriculas = Array.isArray(lido.matriculas) ? lido.matriculas : [];
      dados.excecoes = Array.isArray(lido.excecoes) ? lido.excecoes : [];
    }
  } catch (erro) {
    console.error('[matriculas] não consegui ler, começando vazio:', erro.message);
  }
}

function montar() {
  return JSON.stringify({
    atualizadoEm: new Date().toISOString(),
    total: dados.matriculas.length,
    matriculas: dados.matriculas,
    excecoes: dados.excecoes,
  }, null, 2);
}

function gravar() {
  if (!pendente) {
    pendente = setTimeout(() => {
      pendente = null;
      try {
        fs.mkdirSync(DIR, { recursive: true });
        const temp = `${ARQUIVO}.tmp`;
        fs.writeFileSync(temp, montar());
        fs.renameSync(temp, ARQUIVO);
      } catch (erro) {
        console.error('[matriculas] falha ao gravar:', erro.message);
      }
    }, 300);
    if (pendente.unref) pendente.unref();
  }
  backup.sincronizar(montar);
}

/**
 * Primeiro boot com o volume vazio: puxa a base do backup. É assim que os 120
 * alunos da planilha entram — o arquivo é commitado no repo privado e o serviço
 * se serve dele sozinho, sem endpoint de importação e sem upload manual.
 *
 * Só semeia quando a base local está vazia. Base com conteúdo nunca é
 * sobrescrita pelo backup: o volume manda.
 */
async function semear() {
  if (semeando || dados.matriculas.length || !backup.ligado) return;
  semeando = true;
  try {
    const remoto = await backup.baixar();
    if (!remoto || !Array.isArray(remoto.matriculas) || !remoto.matriculas.length) {
      console.log('[matriculas] sem backup para semear; base começa vazia.');
      return;
    }
    if (dados.matriculas.length) return;   // alguém cadastrou enquanto baixava
    dados.matriculas = remoto.matriculas;
    dados.excecoes = Array.isArray(remoto.excecoes) ? remoto.excecoes : [];
    normalizarHorarios();
    // Grava direto no disco, sem chamar gravar(): não faz sentido devolver ao
    // GitHub exatamente aquilo que acabou de vir de lá.
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(ARQUIVO, montar());
    console.log(`[matriculas] base semeada do backup: ${dados.matriculas.length} matrículas.`);
  } catch (erro) {
    console.error('[matriculas] falha ao semear do backup:', erro.message);
  } finally {
    semeando = false;
  }
}

/**
 * Preenche telefones a partir de `teamrausch/telefones.json` no repo privado
 * (`{ telefones: [{ id, telefone }] }`). Só toca em matrícula SEM telefone:
 * o que já foi preenchido na ficha nunca é sobrescrito, então rodar de novo é
 * seguro. Roda no boot, depois da semeadura, e sob demanda pelo endpoint
 * `/matriculas/telefones/aplicar` (PANEL_TOKEN).
 *
 * Por que não editar o backup direto: o volume manda, e o backup só semeia a
 * base vazia — telefone colocado lá à mão nunca chegaria ao app, e o próximo
 * backup ainda o apagaria.
 */
async function complementarTelefones() {
  if (!fonteTelefones.ligado) {
    return { ok: false, motivo: 'Defina GITHUB_TOKEN e GITHUB_REPO para ler o arquivo de telefones.' };
  }
  const remoto = await fonteTelefones.baixar();
  const lista = remoto && Array.isArray(remoto.telefones) ? remoto.telefones : [];
  const resultado = { ok: true, noArquivo: lista.length, aplicados: 0, jaTinham: 0, naoEncontrados: [] };
  const agora = new Date().toISOString();

  for (const item of lista) {
    const m = porId(String(item && item.id || ''));
    if (!m) { resultado.naoEncontrados.push(item && item.id); continue; }
    const telefone = String(item.telefone || '').trim();
    if (!telefone) continue;
    if (m.telefone) { resultado.jaTinham += 1; continue; }
    m.telefone = telefone;
    m.atualizadoEm = agora;
    resultado.aplicados += 1;
  }

  if (resultado.aplicados) gravar();
  console.log('[matriculas] telefones:', JSON.stringify(resultado));
  return resultado;
}

/* ------------------------------ validação -------------------------------- */

function ehHora(h) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(h || ''));
}

/**
 * O estúdio trabalha em horas cheias. A planilha de origem trazia horários
 * quebrados (05:20, 06:40, 17:30) que eram a hora de chegada de cada um, não
 * turmas diferentes — e cada minuto distinto virava um horário próprio na
 * agenda, com lotação própria, invisível para quem quisesse reservar.
 *
 * Descartamos os minutos em vez de arredondar para o mais próximo: 06:40
 * pertence à turma das 06:00, não à das 07:00. O texto original da planilha
 * continua guardado em `freqOriginal`, então nada se perde.
 */
function horaCheia(h) {
  const bruto = String(h || '').trim();
  return ehHora(bruto) ? `${bruto.slice(0, 2)}:00` : bruto;
}

/** Normaliza a grade e recusa entrada torta em vez de gravar lixo silenciosamente. */
function limparGrade(bruta) {
  if (bruta === undefined) return { ok: true, grade: undefined };
  if (!Array.isArray(bruta)) return { ok: false, motivo: 'Grade inválida.' };

  const vistos = new Set();
  const limpa = [];
  for (const s of bruta) {
    const dia = Number(s.dia);
    const hora = String(s.hora || '').trim();
    if (!Number.isInteger(dia) || dia < 0 || dia > 6) {
      return { ok: false, motivo: `Dia da semana inválido: ${s.dia}` };
    }
    if (!ehHora(hora)) return { ok: false, motivo: `Horário inválido: ${s.hora}` };
    const cheia = horaCheia(hora);
    const chave = `${dia}|${cheia}`;
    if (vistos.has(chave)) continue;   // repetido é engano de digitação, não erro
    vistos.add(chave);
    limpa.push({ dia, hora: cheia });
  }
  limpa.sort((a, b) => a.dia - b.dia || a.hora.localeCompare(b.hora));
  return { ok: true, grade: limpa };
}

function mesmaGrade(a = [], b = []) {
  if (a.length !== b.length) return false;
  return a.every((s, i) => s.dia === b[i].dia && s.hora === b[i].hora);
}

/* ------------------------------ matrículas ------------------------------- */

function novoId() {
  return 'm' + crypto.randomBytes(6).toString('hex');
}

function hojeISO() {
  return new Date().toISOString().slice(0, 10);
}

function listar() {
  return dados.matriculas
    .slice()
    .sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'));
}

function porId(id) {
  return dados.matriculas.find((m) => m.id === id) || null;
}

/**
 * Telefone é a ponte com o cadastro de login (`agenda-store`), onde ele é a
 * chave primária. Comparamos só os dígitos e aceitamos casar pelos 8 finais:
 * o mesmo número aparece ora com DDI, ora sem, ora com o nono dígito — exigir
 * igualdade literal deixaria a matrícula desvinculada por causa de um '55'.
 */
function soDigitos(t) {
  return String(t || '').replace(/\D/g, '');
}

function mesmoTelefone(a, b) {
  const x = soDigitos(a);
  const y = soDigitos(b);
  if (x.length < 8 || y.length < 8) return false;
  return x === y || x.slice(-8) === y.slice(-8);
}

/** Matrícula ativa ligada a um telefone de login, ou null. */
function porTelefone(telefone) {
  const t = soDigitos(telefone);
  if (t.length < 8) return null;
  return dados.matriculas.find((m) => m.ativo && mesmoTelefone(m.telefone, t)) || null;
}

/**
 * Ponte com o Wellhub. O portal identifica o aluno pelo `gympass_id`; guardar
 * esse número na matrícula é o que permite creditar um check-in na ficha certa
 * sem depender de o nome estar escrito igual nos dois lugares.
 */
function porGympassId(gympassId) {
  const alvo = String(gympassId || '').trim();
  if (!alvo) return null;
  return dados.matriculas.find((m) => String(m.gympassId || '') === alvo) || null;
}

/**
 * Grava o id do Wellhub. Recusa em silêncio quando o número já é de outro
 * aluno: dois alunos com o mesmo id fariam os check-ins de um cair na ficha do
 * outro, e o erro só apareceria semanas depois, como falta.
 */
function definirGympassId(id, gympassId) {
  const m = porId(id);
  if (!m) return { ok: false, motivo: 'Matrícula não encontrada.' };
  const alvo = String(gympassId || '').trim() || null;

  if (alvo) {
    const dono = porGympassId(alvo);
    if (dono && dono.id !== id) {
      return { ok: false, motivo: `Este Wellhub ID já é de ${dono.nome}.` };
    }
  }
  m.gympassId = alvo;
  m.atualizadoEm = new Date().toISOString();
  gravar();
  return { ok: true, matricula: m };
}

/**
 * Caixa do nome vindo do portal.
 *
 * O Wellhub costuma mandar tudo em maiúsculas. Copiar literal deixaria a base
 * gritando — e, pior, a cobrança automática sairia como "Oi, MARIA!", porque
 * ela usa o primeiro nome do cadastro. Então: nome que chega todo em uma caixa
 * só é arrumado; nome que chega com caixa mista já veio escrito por gente e é
 * preservado como está.
 *
 * As partículas ficam minúsculas ('Maria da Silva', não 'Maria Da Silva').
 * WELLHUB_NOME_LITERAL=true desliga tudo isto e grava exatamente o que veio.
 */
const PARTICULAS = ['da', 'de', 'do', 'das', 'dos', 'e', 'del', 'di', 'du',
  'la', 'las', 'los', 'van', 'von', 'der', 'den', 'y'];

function arrumarCaixa(nome) {
  const bruto = String(nome || '').trim().replace(/\s+/g, ' ');
  if (!bruto) return '';
  if (String(process.env.WELLHUB_NOME_LITERAL || 'false') === 'true') return bruto;

  const soMaiusculas = bruto === bruto.toLocaleUpperCase('pt-BR');
  const soMinusculas = bruto === bruto.toLocaleLowerCase('pt-BR');
  if (!soMaiusculas && !soMinusculas) return bruto;   // veio bem escrito

  return bruto.split(' ').map((palavra, i) => {
    const p = palavra.toLocaleLowerCase('pt-BR');
    if (i > 0 && PARTICULAS.includes(p)) return p;
    return p.charAt(0).toLocaleUpperCase('pt-BR') + p.slice(1);
  }).join(' ');
}

/**
 * Adota o nome que o Wellhub usa para este aluno.
 *
 * Roda quando o check-in é vinculado à matrícula. A base veio de uma planilha
 * com apelidos e abreviações; o portal tem o nome do cadastro real, e é por ele
 * que a pessoa é identificada na hora de conferir a fila.
 *
 * APLICA UMA VEZ POR NOME, NÃO A CADA CHECK-IN
 *   `nomeWellhub` guarda o último nome que veio do portal. Se ele já é o que
 *   está gravado, nada acontece — assim, se você corrigir o nome na tela depois,
 *   a correção fica de pé em vez de ser desfeita no próximo check-in. Só quando
 *   o portal passa a mandar um nome diferente é que a troca acontece de novo.
 *
 * O nome que estava na planilha vai para `nomeOriginal` e nunca se perde.
 */
function renomearDoWellhub(id, nomeDoPortal) {
  const m = porId(id);
  if (!m) return { ok: false, motivo: 'Matrícula não encontrada.' };

  const literal = String(nomeDoPortal || '').trim().replace(/\s+/g, ' ');
  if (!literal) return { ok: true, mudou: false };

  // Este nome do portal já foi processado (adotado ou recusado). Não insiste.
  if (m.nomeWellhub === literal) return { ok: true, mudou: false };
  m.nomeWellhub = literal;

  const novo = arrumarCaixa(literal);
  if (!novo || novo === m.nome) { gravar(); return { ok: true, mudou: false }; }

  // Nome único continua sendo regra: dois cadastros com o mesmo nome quebram a
  // busca e o vínculo por nome. Aqui a colisão é sinal de matrícula duplicada,
  // que é coisa para você olhar — não para o sistema resolver sozinho.
  const conflito = comMesmoNome(novo, id);
  if (conflito) {
    gravar();
    return { ok: false, mudou: false, motivo: `Já existe outro aluno chamado ${novo}.` };
  }

  if (!m.nomeOriginal) m.nomeOriginal = m.nome;
  const antes = m.nome;
  m.nome = novo;
  m.atualizadoEm = new Date().toISOString();
  gravar();
  return { ok: true, mudou: true, de: antes, para: novo };
}

function comMesmoNome(nome, exceto) {
  const alvo = String(nome).trim().toLocaleLowerCase('pt-BR');
  return dados.matriculas.find((m) =>
    m.id !== exceto && String(m.nome).trim().toLocaleLowerCase('pt-BR') === alvo) || null;
}

function criar(campos = {}) {
  const nome = String(campos.nome || '').trim();
  if (!nome) return { ok: false, motivo: 'Informe o nome do aluno.' };
  if (comMesmoNome(nome)) return { ok: false, motivo: 'Já existe um aluno com esse nome.' };

  const vinculo = String(campos.vinculo || 'mensalista');
  if (!VINCULOS.includes(vinculo)) return { ok: false, motivo: 'Vínculo inválido.' };

  const g = limparGrade(campos.grade === undefined ? [] : campos.grade);
  if (!g.ok) return { ok: false, motivo: g.motivo };

  const registro = {
    id: novoId(),
    nome,
    telefone: String(campos.telefone || '').trim() || null,
    gympassId: String(campos.gympassId || '').trim() || null,
    aniversario: null,   // preenchido logo abaixo, com validação
    ativo: campos.ativo === undefined ? true : Boolean(campos.ativo),
    // Aula experimental: a pessoa já treina e já tem ficha, mas o horário fixo
    // ainda não foi combinado. Sem esta marca ela ficaria indistinguível de um
    // aluno de verdade que alguém esqueceu de montar a grade.
    experimental: Boolean(campos.experimental),
    vinculo,
    grade: g.grade,
    vigenteDe: String(campos.vigenteDe || hojeISO()),
    gradeAnterior: [],
    observacao: String(campos.observacao || '').trim() || null,
    criadoEm: new Date().toISOString(),
    atualizadoEm: new Date().toISOString(),
  };

  if (campos.aniversario !== undefined) {
    const r = aplicarAniversario(registro, campos.aniversario);
    if (!r.ok) return r;
  }

  if (vinculo === 'mensalista') {
    const r = aplicarCobranca(registro, campos);
    if (!r.ok) return r;
  }

  dados.matriculas.push(registro);
  gravar();
  return { ok: true, matricula: registro };
}

/**
 * Dia e mês de nascimento. Campo em branco apaga a data — é assim que se
 * corrige um valor errado sem precisar de um botão só para isso.
 */
function aplicarAniversario(registro, bruto) {
  const texto = String(bruto ?? '').trim();
  if (!texto) { registro.aniversario = null; return { ok: true }; }
  const limpo = aniversario.normalizar(texto);
  if (!limpo) {
    return { ok: false, motivo: 'Nascimento inválido. Use dia e mês, como 07/03.' };
  }
  registro.aniversario = limpo;
  return { ok: true };
}

/** Ciclo e dia de vencimento existem só para mensalista. */
function aplicarCobranca(registro, campos) {
  if (campos.ciclo !== undefined) {
    const ciclo = String(campos.ciclo || 'mensal');
    if (!CICLOS.includes(ciclo)) return { ok: false, motivo: 'Ciclo de pagamento inválido.' };
    registro.ciclo = ciclo;
  } else if (!registro.ciclo) {
    registro.ciclo = 'mensal';
  }

  if (campos.diaVencimento !== undefined) {
    const bruto = String(campos.diaVencimento).trim();
    if (!bruto) {
      registro.diaVencimento = null;
    } else {
      const dia = Number(bruto);
      if (!Number.isInteger(dia) || dia < 1 || dia > 31) {
        return { ok: false, motivo: 'Dia de vencimento inválido. Use um número de 1 a 31.' };
      }
      registro.diaVencimento = dia;
    }
  } else if (registro.diaVencimento === undefined) {
    registro.diaVencimento = null;
  }

  if (campos.obsVencimento !== undefined) {
    registro.obsVencimento = String(campos.obsVencimento || '').trim() || null;
  }
  return { ok: true };
}

function atualizar(id, campos = {}) {
  const m = porId(id);
  if (!m) return { ok: false, motivo: 'Matrícula não encontrada.' };

  if (campos.nome !== undefined) {
    const nome = String(campos.nome).trim();
    if (!nome) return { ok: false, motivo: 'Informe o nome do aluno.' };
    if (comMesmoNome(nome, id)) return { ok: false, motivo: 'Já existe um aluno com esse nome.' };
    m.nome = nome;
    // Voltou ao nome da planilha: a marca de "renomeado pelo Wellhub" não faz
    // mais sentido e some da ficha.
    if (m.nomeOriginal === nome) delete m.nomeOriginal;
  }

  if (campos.telefone !== undefined) {
    m.telefone = String(campos.telefone || '').trim() || null;
  }
  if (campos.gympassId !== undefined) {
    const r = definirGympassId(id, campos.gympassId);
    if (!r.ok) return r;
  }
  if (campos.aniversario !== undefined) {
    const r = aplicarAniversario(m, campos.aniversario);
    if (!r.ok) return r;
  }
  if (campos.ativo !== undefined) m.ativo = Boolean(campos.ativo);
  if (campos.experimental !== undefined) m.experimental = Boolean(campos.experimental);
  if (campos.observacao !== undefined) {
    m.observacao = String(campos.observacao || '').trim() || null;
  }

  if (campos.vinculo !== undefined) {
    const vinculo = String(campos.vinculo);
    if (!VINCULOS.includes(vinculo)) return { ok: false, motivo: 'Vínculo inválido.' };
    m.vinculo = vinculo;
  }

  if (m.vinculo === 'mensalista') {
    const r = aplicarCobranca(m, campos);
    if (!r.ok) return r;
  } else {
    // Deixou de ser mensalista: os campos de cobrança somem em vez de ficarem
    // pendurados com valor velho aparecendo na ficha.
    delete m.ciclo;
    delete m.diaVencimento;
    delete m.obsVencimento;
  }

  if (campos.grade !== undefined) {
    const g = limparGrade(campos.grade);
    if (!g.ok) return { ok: false, motivo: g.motivo };
    if (!mesmaGrade(m.grade || [], g.grade)) {
      // Arquiva a grade que estava valendo até ontem. Sem isto, a tela de um dia
      // passado mostraria o aluno no horário novo, como se sempre tivesse sido.
      const ontem = grade.somarDias(hojeISO(), -1);
      const desde = m.vigenteDe || m.criadoEm?.slice(0, 10) || ontem;
      if (desde <= ontem) {
        m.gradeAnterior = [
          { grade: m.grade || [], vigenteDe: desde, vigenteAte: ontem },
          ...(m.gradeAnterior || []),
        ].slice(0, 12);
      }
      m.grade = g.grade;
      m.vigenteDe = hojeISO();
    }
  }

  // "Revisar" é a marca dos registros importados com ambiguidade na planilha.
  // Some assim que você confirma a ficha.
  if (campos.revisado) delete m.revisar;

  m.atualizadoEm = new Date().toISOString();
  gravar();
  return { ok: true, matricula: m };
}

/** Inativar preserva o histórico. Remover apaga de vez, com as exceções junto. */
function inativar(id) {
  const m = porId(id);
  if (!m) return { ok: false, motivo: 'Matrícula não encontrada.' };
  m.ativo = false;
  m.atualizadoEm = new Date().toISOString();
  gravar();
  return { ok: true, matricula: m };
}

function remover(id) {
  const antes = dados.matriculas.length;
  dados.matriculas = dados.matriculas.filter((m) => m.id !== id);
  if (dados.matriculas.length === antes) {
    return { ok: false, motivo: 'Matrícula não encontrada.' };
  }
  dados.excecoes = dados.excecoes.filter((e) => e.matriculaId !== id);
  gravar();
  return { ok: true };
}

/* ------------------------------- exceções -------------------------------- */

function excecoes({ de, ate, matriculaId } = {}) {
  return dados.excecoes.filter((e) =>
    (!de || e.data >= de) &&
    (!ate || e.data <= ate) &&
    (!matriculaId || e.matriculaId === matriculaId));
}

function registrarExcecao({ matriculaId, data, tipo, hora, motivo }) {
  const m = porId(matriculaId);
  if (!m) return { ok: false, motivo: 'Matrícula não encontrada.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data || ''))) {
    return { ok: false, motivo: 'Data inválida.' };
  }
  if (!['cancelou', 'extra'].includes(tipo)) {
    return { ok: false, motivo: 'Tipo de exceção inválido.' };
  }
  if (tipo === 'extra' && !ehHora(hora)) {
    return { ok: false, motivo: 'Informe o horário da aula extra.' };
  }
  if (tipo === 'cancelou' && hora && !ehHora(hora)) {
    return { ok: false, motivo: 'Horário inválido.' };
  }

  const igual = dados.excecoes.find((e) =>
    e.matriculaId === matriculaId && e.data === data && e.tipo === tipo &&
    (e.hora || null) === (hora || null));
  if (igual) return { ok: true, excecao: igual };

  const registro = {
    id: 'e' + crypto.randomBytes(6).toString('hex'),
    matriculaId,
    nome: m.nome,
    data,
    tipo,
    hora: hora || null,
    motivo: String(motivo || '').trim() || null,
    criadoEm: new Date().toISOString(),
  };
  dados.excecoes.push(registro);
  gravar();
  return { ok: true, excecao: registro };
}

function apagarExcecao(id) {
  const antes = dados.excecoes.length;
  dados.excecoes = dados.excecoes.filter((e) => e.id !== id);
  if (dados.excecoes.length === antes) return { ok: false, motivo: 'Exceção não encontrada.' };
  gravar();
  return { ok: true };
}

/** Guarda um ano de exceções: passado disso não alimenta mais nenhuma tela. */
function limparAntigas(dias = 365) {
  const corte = grade.somarDias(hojeISO(), -dias);
  const antes = dados.excecoes.length;
  dados.excecoes = dados.excecoes.filter((e) => e.data >= corte);
  if (dados.excecoes.length !== antes) gravar();
}

/* ----------------------------- migração ---------------------------------- */

/**
 * Passa a base inteira para hora cheia — a que já estava gravada antes de
 * `limparGrade` normalizar. Roda no boot e é idem­potente: sem horário quebrado
 * na base, não grava nada e não devolve o arquivo ao GitHub à toa.
 *
 * Mexe também no histórico (`gradeAnterior`) e nas exceções: uma exceção
 * apontando para 06:40 deixaria de casar com a aula, que agora é 06:00, e a
 * falta desapareceria da projeção.
 */
function normalizarHorarios() {
  let mudou = 0;

  const arrumarGrade = (lista) => {
    const vistos = new Set();
    const saida = [];
    for (const s of lista || []) {
      const cheia = horaCheia(s.hora);
      if (cheia !== s.hora) mudou += 1;
      const chave = `${s.dia}|${cheia}`;
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      saida.push({ ...s, hora: cheia });
    }
    saida.sort((a, b) => a.dia - b.dia || a.hora.localeCompare(b.hora));
    return saida;
  };

  for (const m of dados.matriculas) {
    m.grade = arrumarGrade(m.grade);
    for (const h of m.gradeAnterior || []) h.grade = arrumarGrade(h.grade);
  }
  for (const e of dados.excecoes) {
    if (!e.hora) continue;
    const cheia = horaCheia(e.hora);
    if (cheia !== e.hora) { e.hora = cheia; mudou += 1; }
  }

  if (mudou) {
    console.log(`[matriculas] ${mudou} horários quebrados passaram para a hora cheia.`);
    gravar();
  }
  return mudou;
}

/* ------------------------------ importação ------------------------------- */

/**
 * Importa uma lista de matrículas. Por segurança só roda com a base vazia,
 * a menos que `substituir` venha explicitamente — importar por cima de uma base
 * em uso apagaria cadastros feitos na tela.
 */
function importar(lista, { substituir = false } = {}) {
  if (!Array.isArray(lista) || !lista.length) {
    return { ok: false, motivo: 'Nada para importar.' };
  }
  if (dados.matriculas.length && !substituir) {
    return {
      ok: false,
      motivo: `A base já tem ${dados.matriculas.length} matrículas. Use substituir=true para trocar tudo.`,
    };
  }

  const agora = new Date().toISOString();
  const hoje = hojeISO();
  const novas = [];
  const recusadas = [];

  for (const bruta of lista) {
    const nome = String(bruta.nome || '').trim();
    if (!nome) { recusadas.push({ nome: bruta.nome, motivo: 'sem nome' }); continue; }

    const g = limparGrade(bruta.grade || []);
    if (!g.ok) { recusadas.push({ nome, motivo: g.motivo }); continue; }

    const vinculo = VINCULOS.includes(bruta.vinculo) ? bruta.vinculo : 'mensalista';
    const registro = {
      id: bruta.id || novoId(),
      nome,
      telefone: String(bruta.telefone || '').trim() || null,
      gympassId: String(bruta.gympassId || '').trim() || null,
      aniversario: aniversario.normalizar(bruta.aniversario),
      ativo: bruta.ativo === undefined ? true : Boolean(bruta.ativo),
      vinculo,
      grade: g.grade,
      vigenteDe: String(bruta.vigenteDe || hoje),
      gradeAnterior: [],
      freqOriginal: bruta.freqOriginal || null,
      criadoEm: agora,
      atualizadoEm: agora,
    };
    if (vinculo === 'mensalista') {
      registro.ciclo = CICLOS.includes(bruta.ciclo) ? bruta.ciclo : 'mensal';
      const dia = Number(bruta.diaVencimento);
      registro.diaVencimento = Number.isInteger(dia) && dia >= 1 && dia <= 31 ? dia : null;
      if (bruta.obsVencimento) registro.obsVencimento = String(bruta.obsVencimento);
    }
    if (Array.isArray(bruta.revisar) && bruta.revisar.length) registro.revisar = bruta.revisar;
    novas.push(registro);
  }

  dados.matriculas = novas;
  dados.excecoes = [];
  gravar();
  return { ok: true, importadas: novas.length, recusadas };
}

/* -------------------------------- resumo --------------------------------- */

function resumo() {
  const ativas = dados.matriculas.filter((m) => m.ativo);
  return {
    total: dados.matriculas.length,
    ativas: ativas.length,
    inativas: dados.matriculas.length - ativas.length,
    wellhub: ativas.filter((m) => m.vinculo === 'wellhub').length,
    mensalistas: ativas.filter((m) => m.vinculo === 'mensalista').length,
    semTelefone: ativas.filter((m) => !m.telefone).length,
    experimentais: ativas.filter((m) => m.experimental).length,
    // Wellhub sem id é aluno cujo check-in ainda não tem onde cair.
    semWellhubId: ativas.filter((m) => m.vinculo === 'wellhub' && !m.gympassId).length,
    semAniversario: ativas.filter((m) => !m.aniversario).length,
    aRevisar: dados.matriculas.filter((m) => (m.revisar || []).length).length,
    excecoes: dados.excecoes.length,
  };
}

carregar();
normalizarHorarios();
semear()
  .then(() => complementarTelefones())
  .catch((erro) => console.error('[matriculas] falha ao complementar telefones:', erro.message));
setInterval(() => limparAntigas(), 24 * 3600000).unref();

module.exports = {
  listar, porId, porTelefone, porGympassId, definirGympassId, renomearDoWellhub, arrumarCaixa,
  criar, atualizar, inativar, remover,
  excecoes, registrarExcecao, apagarExcecao,
  importar, resumo, backup, normalizarHorarios, horaCheia, complementarTelefones,
  VINCULOS, CICLOS,
};
