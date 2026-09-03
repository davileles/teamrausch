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
const CAMINHO_WELLHUB_IDS = process.env.GITHUB_PATH_WELLHUB_IDS
  || 'teamrausch/wellhub-ids.json';
// Data em que cada aluno começou a treinar de fato, quando ela é anterior ao
// cadastro da ficha. Toda a base entrou de uma vez em 24/08, e sem isto a
// projeção de agenda de quem não passa pelo portal começa na data da
// importação — o mensalista aparecia com uma semana de mês em vez de um mês.
const CAMINHO_INICIOS = process.env.GITHUB_PATH_INICIOS
  || 'teamrausch/inicio-alunos.json';

const VINCULOS = ['wellhub', 'mensalista'];
const CICLOS = ['mensal', 'trimestral', 'semestral', 'anual'];

const backup = backupGithub.criar(CAMINHO_BACKUP, 'Matrículas do estúdio');
const fonteTelefones = backupGithub.criar(CAMINHO_TELEFONES, 'Telefones (leitura)');
const fonteWellhubIds = backupGithub.criar(CAMINHO_WELLHUB_IDS, 'Wellhub IDs (leitura)');
const fonteInicios = backupGithub.criar(CAMINHO_INICIOS, 'Início dos alunos (leitura)');

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

/**
 * Grava Wellhub IDs identificados na mão, a partir de
 * `teamrausch/wellhub-ids.json` no repo privado
 * (`{ vinculos: [{ id, nome, gympassId }] }`).
 *
 * Existe pelo mesmo motivo do arquivo de telefones: o volume é a fonte de
 * verdade, então editar `matriculas.json` no repositório não chega ao app — o
 * backup só semeia base vazia, e o próximo `gravar()` apagaria a edição. É o
 * caminho para ligar alunos que nunca apareceram no portal e por isso não têm
 * check-in órfão para vincular pela tela.
 *
 * SÓ PREENCHE O QUE ESTÁ VAZIO
 *   Ficha que já tem ID é pulada, e ID que já pertence a outra ficha também —
 *   um arquivo desatualizado não pode desfazer vínculo feito na tela. Rodar de
 *   novo é seguro; roda no boot e pelo endpoint `/matriculas/wellhub/aplicar`.
 *
 * `nome` no arquivo é conferência, não busca: se não bater com a ficha, o
 * vínculo é recusado. O id é curto e um dígito trocado apontaria para o aluno
 * errado sem nenhum sinal.
 */
async function complementarWellhubIds() {
  if (!fonteWellhubIds.ligado) {
    return { ok: false, motivo: 'Defina GITHUB_TOKEN e GITHUB_REPO para ler o arquivo.' };
  }
  const remoto = await fonteWellhubIds.baixar();
  const lista = remoto && Array.isArray(remoto.vinculos) ? remoto.vinculos : [];
  const r = { ok: true, noArquivo: lista.length, aplicados: [], jaTinham: [], recusados: [] };

  for (const item of lista) {
    const alvo = String((item && item.id) || '');
    const gympassId = String((item && item.gympassId) || '').trim();
    const m = porId(alvo);
    if (!m) { r.recusados.push({ id: alvo, motivo: 'ficha não encontrada' }); continue; }
    if (!gympassId) { r.recusados.push({ id: alvo, motivo: 'sem Wellhub ID' }); continue; }

    const igual = (a, b) => String(a || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR')
      === String(b || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
    if (item.nome && !igual(item.nome, m.nome)) {
      r.recusados.push({ id: alvo, motivo: `nome não confere: arquivo "${item.nome}", ficha "${m.nome}"` });
      continue;
    }
    if (m.gympassId) {
      r.jaTinham.push({ id: alvo, nome: m.nome, gympassId: m.gympassId });
      continue;
    }
    const dono = porGympassId(gympassId);
    if (dono && dono.id !== m.id) {
      r.recusados.push({ id: alvo, motivo: `Wellhub ID já é de ${dono.nome}` });
      continue;
    }
    const feito = definirGympassId(m.id, gympassId);
    if (feito.ok) r.aplicados.push({ id: alvo, nome: m.nome, gympassId });
    else r.recusados.push({ id: alvo, motivo: feito.motivo });
  }

  console.log('[matriculas] wellhub ids:', JSON.stringify({
    aplicados: r.aplicados.length, jaTinham: r.jaTinham.length, recusados: r.recusados.length,
  }));
  for (const x of r.recusados) console.log(`[matriculas] wellhub id recusado — ${x.id}: ${x.motivo}`);
  return r;
}

/**
 * Preenche `desde` — o dia em que o aluno começou a treinar — a partir do
 * arquivo no repositório privado.
 *
 * POR QUE UM ARQUIVO E NÃO UMA REGRA
 *   A tentação é deduzir: "ficha criada no dia da importação, logo o aluno já
 *   treinava antes". Só que isso vale para as 120 fichas que entraram em 24/08
 *   e é falso para o aluno que se matriculou de verdade naquele dia — e os dois
 *   casos são indistinguíveis olhando a ficha. Um arquivo com a lista resolve o
 *   caso conhecido sem plantar uma heurística que erra sozinha no futuro.
 *
 * IDEMPOTENTE: ficha que já tem `desde` é pulada, então rodar de novo a cada
 * boot não sobrescreve o que alguém corrigiu na mão depois.
 */
async function complementarInicios() {
  if (!fonteInicios.ligado) {
    return { ok: false, motivo: 'Defina GITHUB_TOKEN e GITHUB_REPO para ler o arquivo.' };
  }
  const remoto = await fonteInicios.baixar();
  const lista = remoto && Array.isArray(remoto.inicios) ? remoto.inicios : [];
  const r = { ok: true, noArquivo: lista.length, aplicados: 0, jaTinham: 0, recusados: [] };

  for (const item of lista) {
    const alvo = String((item && item.id) || '');
    const desde = String((item && item.desde) || '').trim();
    const m = porId(alvo);
    if (!m) { r.recusados.push({ id: alvo, motivo: 'ficha não encontrada' }); continue; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(desde)) {
      r.recusados.push({ id: alvo, motivo: `data inválida: "${desde}"` });
      continue;
    }
    if (m.desde) { r.jaTinham += 1; continue; }
    m.desde = desde;
    m.atualizadoEm = new Date().toISOString();
    r.aplicados += 1;
  }
  if (r.aplicados) gravar();

  console.log('[matriculas] início dos alunos:', JSON.stringify({
    aplicados: r.aplicados, jaTinham: r.jaTinham, recusados: r.recusados.length,
  }));
  for (const x of r.recusados) console.log(`[matriculas] início recusado — ${x.id}: ${x.motivo}`);
  return r;
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

/**
 * Normaliza a grade e recusa entrada torta em vez de gravar lixo silenciosamente.
 *
 * Um horário por dia (ver `grade.conflitosDeGrade`). O que fazer quando o dia
 * vem repetido depende de quem está mandando:
 *
 *   'recusar' — padrão, para a tela e a API: tem gente do outro lado para
 *               escolher qual horário fica;
 *   'reduzir' — para a planilha, que roda sozinha de madrugada: fica o mais
 *               cedo e o outro vira aviso de revisão na ficha, em vez de a
 *               linha inteira ser recusada e o aluno não entrar;
 *   'manter'  — para restaurar backup e para reler grade já gravada: aqui o
 *               arquivo é a verdade, e validar seria apagar o passado.
 */
function limparGrade(bruta, { conflito = 'recusar' } = {}) {
  if (bruta === undefined) return { ok: true, grade: undefined };
  if (!Array.isArray(bruta)) return { ok: false, motivo: 'Grade inválida.' };

  const vistos = new Set();
  const porDia = new Map();
  const limpa = [];
  const descartados = [];
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

    const anterior = porDia.get(dia);
    if (anterior === undefined) {
      porDia.set(dia, cheia);
      limpa.push({ dia, hora: cheia });
      continue;
    }
    if (conflito === 'manter') { limpa.push({ dia, hora: cheia }); continue; }
    if (conflito === 'recusar') {
      return {
        ok: false,
        motivo: `${grade.NOME_DIA[dia]} já está com ${anterior}: cada dia da semana `
          + 'aceita um horário só na grade.',
      };
    }
    // 'reduzir': fica o mais cedo do dia; o outro sai, mas deixa rastro.
    const fica = cheia < anterior ? cheia : anterior;
    const sai = cheia < anterior ? anterior : cheia;
    porDia.set(dia, fica);
    const alvo = limpa.find((x) => x.dia === dia);
    if (alvo) alvo.hora = fica;
    descartados.push({ dia, hora: sai });
  }
  limpa.sort((a, b) => a.dia - b.dia || a.hora.localeCompare(b.hora));
  return { ok: true, grade: limpa, descartados };
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
 * Caixa do nome: primeira letra de cada palavra em maiúscula.
 *
 * Vale para TODO nome que entra na base, venha do portal, da tela ou da
 * planilha. O Wellhub manda tudo em maiúsculas, a planilha tinha de tudo, e a
 * digitação com a pressa do dia a dia sai como sai — sem uma regra só, a lista
 * fica com "ANA SOFIA" ao lado de "ana sofia" e a cobrança automática sai como
 * "Oi, MARIA!", porque ela usa o primeiro nome do cadastro.
 *
 * As partículas ficam minúsculas ('Maria da Silva', não 'Maria Da Silva'), que é
 * como se escreve nome em português.
 * WELLHUB_NOME_LITERAL=true desliga tudo isto e grava exatamente o que veio.
 */
const PARTICULAS = ['da', 'de', 'do', 'das', 'dos', 'e', 'del', 'di', 'du',
  'la', 'las', 'los', 'van', 'von', 'der', 'den', 'y'];

function arrumarCaixa(nome) {
  const bruto = String(nome || '').trim().replace(/\s+/g, ' ');
  if (!bruto) return '';
  if (String(process.env.WELLHUB_NOME_LITERAL || 'false') === 'true') return bruto;

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
 * O NOME DO PORTAL MANDA, SEMPRE
 *   Quem tem Wellhub tem, no portal, o nome que a própria pessoa cadastrou —
 *   completo e escrito direito. É esse que vale. Nome digitado na tela, no
 *   primeiro acesso ou em Meus dados volta para o do portal no check-in
 *   seguinte, e a reaplicação acontece a cada passada, não uma vez por nome:
 *   assim a base e a fila do Wellhub nunca ficam com grafias diferentes.
 *
 *   A exceção é `nomeTravado` — conta em nome de terceiro, onde o nome do
 *   portal comprovadamente não é o do aluno. Ali continua valendo a decisão
 *   tomada na tela.
 *
 * O nome que estava na planilha vai para `nomeOriginal` e nunca se perde.
 */
function renomearDoWellhub(id, nomeDoPortal) {
  const m = porId(id);
  if (!m) return { ok: false, motivo: 'Matrícula não encontrada.' };

  const literal = String(nomeDoPortal || '').trim().replace(/\s+/g, ' ');
  if (!literal) return { ok: true, mudou: false };

  // Conta do Wellhub em nome de outra pessoa (pai, mãe, cônjuge): o portal manda
  // o nome de quem assina o plano, mas quem treina é o aluno desta ficha.
  // `nomeTravado` guarda essa decisão para sempre — sem ela, o próximo check-in
  // (ou o `aplicar-nomes`) rebatizaria o aluno com o nome do titular.
  if (m.nomeTravado) {
    if (m.nomeWellhub === literal && m.titularWellhub) {
      return { ok: true, mudou: false, travado: true };
    }
    m.nomeWellhub = literal;
    if (!m.titularWellhub) m.titularWellhub = literal;
    m.atualizadoEm = new Date().toISOString();
    gravar();
    return { ok: true, mudou: false, travado: true };
  }

  const novo = arrumarCaixa(literal);

  // Já está exatamente como o portal manda: nada a gravar. É o caso comum, e
  // sair aqui evita escrever o arquivo a cada check-in do dia.
  if (m.nomeWellhub === literal && m.nome === novo) return { ok: true, mudou: false };
  m.nomeWellhub = literal;

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

/**
 * Marca a ficha como conta de terceiro: o plano do Wellhub está no nome do
 * titular e quem treina é este aluno. É sempre 1 para 1 — uma conta, um aluno —
 * então o nome do titular vira mais uma chave de reconhecimento do check-in,
 * ao lado do `gympassId`.
 *
 * Grava `nomeWellhub` junto para que `renomearDoWellhub` já considere esse nome
 * processado, e trava o nome do aluno contra a adoção automática.
 */
function definirTitular(id, nomeDoTitular, { travar = true } = {}) {
  const m = porId(id);
  if (!m) return { ok: false, motivo: 'Matrícula não encontrada.' };

  const literal = String(nomeDoTitular || '').trim().replace(/\s+/g, ' ');
  if (literal) {
    m.titularWellhub = literal;
    m.nomeWellhub = literal;
    m.nomeTravado = Boolean(travar);
  } else {
    delete m.titularWellhub;
    delete m.nomeTravado;
  }
  m.atualizadoEm = new Date().toISOString();
  gravar();
  return { ok: true, matricula: m };
}

/**
 * Liga esta ficha à conta Wellhub de outro aluno — ou desfaz, com valor vazio.
 *
 * O caso real: uma pessoa faz o check-in e o pacote cobre duas. O portal só
 * conhece o titular, então sem isto a segunda ficha aparece devendo o mês
 * inteiro, e o titular aparece com uma meta que a conta dele não pode entregar
 * sozinha.
 *
 * Um nível só: o titular precisa ter Wellhub ID próprio e não pode, ele mesmo,
 * compartilhar a conta de um terceiro. Corrente de fichas apontando umas para
 * as outras não tem dono claro, e a divisão da cota deixaria de fechar.
 */
function definirContaDe(id, titularId) {
  const m = porId(id);
  if (!m) return { ok: false, motivo: 'Matrícula não encontrada.' };

  const alvo = String(titularId || '').trim();
  if (!alvo) { delete m.contaDe; m.atualizadoEm = new Date().toISOString(); gravar(); return { ok: true, matricula: m }; }
  if (alvo === id) return { ok: false, motivo: 'A ficha não pode compartilhar a própria conta.' };

  const titular = porId(alvo);
  if (!titular) return { ok: false, motivo: 'Titular não encontrado.' };
  if (!titular.gympassId) {
    return { ok: false, motivo: `${titular.nome} ainda não tem Wellhub ID vinculado.` };
  }
  if (titular.contaDe) {
    return { ok: false, motivo: `${titular.nome} já usa a conta de outra pessoa.` };
  }
  // Quem já é titular de alguém não pode virar dependente: as duas pontas da
  // corrente ficariam sem cota definida.
  if (dados.matriculas.some((x) => x.contaDe === id)) {
    return { ok: false, motivo: 'Esta ficha já é titular de uma conta compartilhada.' };
  }
  if (m.gympassId) {
    return { ok: false, motivo: 'Esta ficha tem Wellhub próprio. Desvincule antes de compartilhar.' };
  }

  m.contaDe = alvo;
  m.atualizadoEm = new Date().toISOString();
  gravar();
  return { ok: true, matricula: m, titular };
}

/** Fichas que treinam na conta desta — vazio quando ela não é titular. */
function dependentesDe(id) {
  return dados.matriculas.filter((m) => m.ativo && m.contaDe === id);
}

function comMesmoNome(nome, exceto) {
  const alvo = String(nome).trim().toLocaleLowerCase('pt-BR');
  return dados.matriculas.find((m) =>
    m.id !== exceto && String(m.nome).trim().toLocaleLowerCase('pt-BR') === alvo) || null;
}

function criar(campos = {}, opcoes = {}) {
  const nome = arrumarCaixa(campos.nome);
  if (!nome) return { ok: false, motivo: 'Informe o nome do aluno.' };
  if (comMesmoNome(nome)) return { ok: false, motivo: 'Já existe um aluno com esse nome.' };

  const vinculo = String(campos.vinculo || 'mensalista');
  if (!VINCULOS.includes(vinculo)) return { ok: false, motivo: 'Vínculo inválido.' };

  const g = limparGrade(campos.grade === undefined ? [] : campos.grade, opcoes);
  if (!g.ok) return { ok: false, motivo: g.motivo };

  const registro = {
    id: novoId(),
    nome,
    telefone: String(campos.telefone || '').trim() || null,
    gympassId: String(campos.gympassId || '').trim() || null,
    // Nome de quem assina o plano, quando não é o próprio aluno.
    titularWellhub: String(campos.titularWellhub || '').trim() || null,
    nomeTravado: campos.nomeTravado === undefined
      ? Boolean(String(campos.titularWellhub || '').trim())
      : Boolean(campos.nomeTravado),
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

  // Horário alternativo que veio junto na célula da planilha: fica escrito na
  // ficha para alguém confirmar, em vez de sumir sem deixar rastro.
  if ((g.descartados || []).length) {
    registro.revisar = g.descartados.map(
      (d) => `${grade.NOME_DIA[d.dia]}: ${d.hora} não entrou (um horário por dia)`);
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
    const nome = arrumarCaixa(campos.nome);
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
  // Preencher o titular já trava o nome; esvaziar o campo devolve a ficha ao
  // comportamento normal (o portal volta a poder corrigir o nome do aluno).
  if (campos.titularWellhub !== undefined) {
    definirTitular(id, campos.titularWellhub);
  }
  // Conta compartilhada: esta ficha treina com o Wellhub de outro aluno. Guarda
  // só o id do titular; a divisão da cota é calculada na hora pela frequência,
  // e não gravada, para acompanhar mudança de grade sem manutenção.
  if (campos.contaDe !== undefined) {
    const r = definirContaDe(id, campos.contaDe);
    if (!r.ok) return r;
  }
  if (campos.nomeTravado !== undefined) {
    if (campos.nomeTravado) m.nomeTravado = true;
    else delete m.nomeTravado;
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
    // A ficha manda a grade inteira em todo salvamento, inclusive quando a
    // edição foi o telefone. Sem esta primeira passada tolerante, os alunos que
    // já estavam gravados com dois horários no mesmo dia — de antes da regra —
    // ficavam impossíveis de editar em qualquer campo. A regra vale a partir do
    // momento em que a grade é mexida.
    const comoEsta = limparGrade(campos.grade, { conflito: 'manter' });
    if (!comoEsta.ok) return { ok: false, motivo: comoEsta.motivo };
    const mudou = !mesmaGrade(m.grade || [], comoEsta.grade);

    const g = mudou ? limparGrade(campos.grade) : comoEsta;
    if (!g.ok) return { ok: false, motivo: g.motivo };
    if (mudou) {
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

/* -------------------------- planilha de alunos ---------------------------- */

/**
 * Cadastro por planilha (ver `planilha-alunos.js`): uma linha por aluno, lida
 * uma vez por dia. Aqui só entra o casamento linha ↔ ficha e a decisão de
 * cadastrar ou não; o download e o parse ficam do outro lado.
 *
 * A PLANILHA É SÓ PORTA DE ENTRADA, NÃO FONTE DE VERDADE
 *   Linha que ainda não tem ficha vira cadastro. Linha que já tem é ignorada —
 *   sem comparar campo, sem atualizar nada. Depois que o aluno entra, quem
 *   manda é a base: o nome que o Wellhub gravou no primeiro check-in, o
 *   telefone corrigido no painel, a grade remontada no meio do mês. Nada disso
 *   pode ser desfeito por uma célula desatualizada numa planilha compartilhada.
 *
 *   O efeito colateral bom é que a planilha pode crescer para sempre sem
 *   ninguém precisar limpar as linhas já processadas: reler a planilha inteira
 *   todo dia custa uma comparação por linha e não muda nada.
 *
 * NUNCA APAGA
 *   Aluno que sumiu da planilha continua na base. Desligar alguém é decisão de
 *   gente — coluna Ativo na ficha ou painel —, não efeito colateral de uma
 *   linha deletada sem querer.
 *
 * Para corrigir um aluno já cadastrado, edite a ficha no painel. Mudar a linha
 * da planilha não tem efeito nenhum, e isso é de propósito.
 */

function chaveNome(nome) {
  return String(nome || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim().toLowerCase().replace(/\s+/g, ' ');
}

function soDigitos(texto) {
  return String(texto || '').replace(/\D/g, '');
}

/** Últimos 8 dígitos: casa 31 99999-8888 com +55 31 99999-8888 e com 999998888. */
function fimDoTelefone(texto) {
  const d = soDigitos(texto);
  return d.length >= 8 ? d.slice(-8) : '';
}

/**
 * Acha a ficha desta linha. A ordem importa: telefone é a identidade mais
 * estável, `planilhaNome` reencontra quem o Wellhub já rebatizou, e o nome só
 * entra depois, para as fichas que existiam antes desta rotina.
 */
function casarComPlanilha(nome, telefone) {
  const tel = fimDoTelefone(telefone);
  if (tel) {
    const achado = dados.matriculas.find((m) => fimDoTelefone(m.telefone) === tel);
    if (achado) return achado;
  }
  const alvo = chaveNome(nome);
  if (!alvo) return null;
  return dados.matriculas.find((m) => m.planilhaNome && chaveNome(m.planilhaNome) === alvo)
    || dados.matriculas.find((m) => chaveNome(m.nome) === alvo)
    || dados.matriculas.find((m) => m.nomeOriginal && chaveNome(m.nomeOriginal) === alvo)
    || null;
}

function sincronizarPlanilha(fichas = [], { seco = false } = {}) {
  if (!Array.isArray(fichas)) return { criadas: [], ignoradas: [], recusadas: [] };

  const criadas = [];
  const ignoradas = [];
  const recusadas = [];
  const vistos = new Set();

  for (const ficha of fichas) {
    const linha = ficha.linha || null;
    const nome = arrumarCaixa(ficha.nome);
    if (!nome) { recusadas.push({ linha, motivo: 'sem nome' }); continue; }

    const marca = chaveNome(nome);
    if (vistos.has(marca)) {
      recusadas.push({ linha, nome, motivo: 'nome repetido na planilha' });
      continue;
    }
    vistos.add(marca);

    const m = casarComPlanilha(nome, ficha.telefone);
    if (m) {
      // Único carimbo feito numa ficha já existente, e só na primeira vez que
      // ela é reconhecida. Sem ele, o dia em que o Wellhub rebatizar o aluno a
      // linha deixa de casar pelo nome e a planilha cadastra um duplicado.
      if (!seco && !m.planilhaNome) { m.planilhaNome = nome; gravar(); }
      ignoradas.push({ id: m.id, nome: m.nome, linha });
      continue;
    }

    if (seco) { criadas.push({ nome, linha }); continue; }

    const campos = {};
    if (String(ficha.telefone || '').trim()) campos.telefone = ficha.telefone;
    if (String(ficha.aniversario || '').trim()) campos.aniversario = ficha.aniversario;
    if (String(ficha.vinculo || '').trim()) campos.vinculo = String(ficha.vinculo).toLowerCase();
    if (String(ficha.ciclo || '').trim()) campos.ciclo = String(ficha.ciclo).toLowerCase();
    if (String(ficha.diaVencimento || '').trim()) campos.diaVencimento = ficha.diaVencimento;
    if (ficha.ativo !== undefined) campos.ativo = ficha.ativo;
    if (ficha.temGrade) campos.grade = ficha.grade || [];

    // `vigenteDe` vale a data informada quando ela é uma data de verdade; o
    // resto do sistema conta a frequência do mensalista a partir dela.
    const inicio = String(ficha.vigenteDe || '').trim();

    const novo = criar({
      ...campos,
      nome,
      ...(/^\d{4}-\d{2}-\d{2}$/.test(inicio) ? { vigenteDe: inicio } : {}),
    }, { conflito: 'reduzir' });
    if (!novo.ok) { recusadas.push({ linha, nome, motivo: novo.motivo }); continue; }

    novo.matricula.planilhaNome = nome;
    novo.matricula.origem = 'planilha';
    gravar();
    criadas.push({ id: novo.matricula.id, nome, linha });
  }

  return { criadas, ignoradas, recusadas };
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

  // Grade com dia repetido não é corrigida aqui de propósito: escolher qual
  // horário fica é decisão de quem conhece o aluno, não de uma migração. O boot
  // só avisa quantas fichas ainda estão assim.
  const emConflito = dados.matriculas.filter(
    (m) => m.ativo && grade.conflitosDeGrade(m.grade).length);
  if (emConflito.length) {
    console.log(`[matriculas] ${emConflito.length} aluno(s) com mais de um horário no `
      + 'mesmo dia — ajuste a grade na ficha.');
  }

  return mudou;
}

/**
 * Resolve as grades que ficaram com mais de um horário no mesmo dia: fica o
 * mais cedo do dia e o outro sai.
 *
 * Fora da migração de boot de propósito — apagar horário de aluno não é coisa
 * que deva acontecer sozinha num deploy. Roda por chamada explícita, e com
 * `seco` mostra o que faria antes de fazer.
 *
 * Não arquiva em `gradeAnterior` nem mexe em `vigenteDe`: isto não é aluno que
 * mudou de horário, é célula de planilha que trouxe o horário alternativo junto.
 * Arquivar carimbaria a correção como mudança de hoje e a contagem do mês do
 * mensalista recomeçaria do zero.
 *
 * Check-ins e exceções ficam como estão: o que já aconteceu aconteceu, e uma
 * aula extra marcada naquele horário é avulsa de verdade, não veio da grade.
 */
function reduzirGradesEmConflito({ seco = false } = {}) {
  const ajustadas = [];

  const reduzir = (lista) => {
    const r = limparGrade(lista || [], { conflito: 'reduzir' });
    return r.ok ? r : { grade: lista || [], descartados: [] };
  };

  for (const m of dados.matriculas) {
    const conflitos = grade.conflitosDeGrade(m.grade);
    const noHistorico = (m.gradeAnterior || [])
      .some((h) => grade.conflitosDeGrade(h.grade).length);
    if (!conflitos.length && !noHistorico) continue;

    const nova = reduzir(m.grade);
    const registro = {
      id: m.id,
      nome: m.nome,
      ativo: Boolean(m.ativo),
      // O que sai da grade atual; o histórico é arrumado junto, mas em silêncio.
      removidos: nova.descartados.map((d) => ({ dia: d.dia, hora: d.hora })),
      ficaram: nova.grade.map((s) => ({ dia: s.dia, hora: s.hora })),
    };
    ajustadas.push(registro);

    if (seco) continue;
    m.grade = nova.grade;
    for (const h of m.gradeAnterior || []) h.grade = reduzir(h.grade).grade;
    m.atualizadoEm = new Date().toISOString();
  }

  if (!seco && ajustadas.length) gravar();
  return { ok: true, seco, total: ajustadas.length, ajustadas };
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
    const nome = arrumarCaixa(bruta.nome);
    if (!nome) { recusadas.push({ nome: bruta.nome, motivo: 'sem nome' }); continue; }

    const g = limparGrade(bruta.grade || [], { conflito: 'manter' });
    if (!g.ok) { recusadas.push({ nome, motivo: g.motivo }); continue; }

    const vinculo = VINCULOS.includes(bruta.vinculo) ? bruta.vinculo : 'mensalista';
    const registro = {
      id: bruta.id || novoId(),
      nome,
      telefone: String(bruta.telefone || '').trim() || null,
      gympassId: String(bruta.gympassId || '').trim() || null,
      titularWellhub: String(bruta.titularWellhub || '').trim() || null,
      nomeTravado: bruta.nomeTravado === undefined
        ? Boolean(String(bruta.titularWellhub || '').trim())
        : Boolean(bruta.nomeTravado),
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

/**
 * Passa a régua da caixa em toda a base, de uma vez.
 *
 * `arrumarCaixa` cuida do que entra daqui para a frente; esta varredura arruma o
 * que já estava gravado — os nomes que vieram da planilha e os que o portal
 * escreveu em caixa alta antes desta regra existir. Roda no boot, e é barata
 * porque só grava quando alguma coisa muda: da segunda vez em diante não faz
 * nada.
 *
 * Cobre também a ficha de login do app, senão a mesma pessoa apareceria escrita
 * de um jeito nesta tela e de outro no app dela.
 */
function normalizarNomes() {
  const trocas = [];

  for (const m of dados.matriculas) {
    for (const campo of ['nome', 'titularWellhub', 'nomeOriginal']) {
      if (!m[campo]) continue;
      const novo = arrumarCaixa(m[campo]);
      if (novo && novo !== m[campo]) {
        if (campo === 'nome') trocas.push({ id: m.id, de: m[campo], para: novo });
        m[campo] = novo;
        m.atualizadoEm = new Date().toISOString();
      }
    }
  }
  if (trocas.length) gravar();

  // `require` aqui dentro, e não no topo: o cadastro de login é outra base, e
  // carregá-la junto com esta na inicialização amarraria os dois módulos sem
  // necessidade.
  let login = 0;
  try {
    const alunosLogin = require('./agenda-store');
    for (const a of alunosLogin.listarAlunos()) {
      if (!a.nome) continue;
      const novo = arrumarCaixa(a.nome);
      if (novo && novo !== a.nome) { alunosLogin.salvarAluno(a.telefone, { nome: novo }); login += 1; }
    }
  } catch (erro) {
    console.error('[matriculas] não consegui normalizar os nomes do login:', erro.message);
  }

  if (trocas.length || login) {
    console.log(`[matriculas] nomes normalizados: ${trocas.length} matrícula(s), ${login} ficha(s) de login.`);
  }
  return { ok: true, trocas, login };
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
    contasDeTerceiro: ativas.filter((m) => m.titularWellhub).length,
    semAniversario: ativas.filter((m) => !m.aniversario).length,
    aRevisar: dados.matriculas.filter((m) => (m.revisar || []).length).length,
    excecoes: dados.excecoes.length,
  };
}

carregar();
normalizarHorarios();
semear()
  .then(() => complementarTelefones())
  .then(() => complementarWellhubIds())
  .then(() => complementarInicios().catch((e) => {
    console.error('[matriculas] início dos alunos falhou:', e.message);
  }))
  // Depois do semeio: normalizar antes dele arrumaria uma base ainda vazia.
  .then(() => normalizarNomes())
  .catch((erro) => console.error('[matriculas] falha ao preparar a base:', erro.message));
setInterval(() => limparAntigas(), 24 * 3600000).unref();

module.exports = {
  listar, porId, porTelefone, porGympassId, definirGympassId, definirTitular,
  renomearDoWellhub, arrumarCaixa,
  criar, atualizar, inativar, remover, definirContaDe, dependentesDe,
  excecoes, registrarExcecao, apagarExcecao,
  importar, sincronizarPlanilha, resumo, backup, normalizarHorarios, normalizarNomes,
  reduzirGradesEmConflito,
  horaCheia,
  complementarTelefones, complementarWellhubIds, complementarInicios,
  VINCULOS, CICLOS,
};
