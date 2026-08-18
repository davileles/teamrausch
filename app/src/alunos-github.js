'use strict';

/**
 * Cópia da ficha dos alunos num repositório do GitHub.
 *
 * O volume do Railway já é a fonte de verdade. Isto aqui é backup: se o
 * volume for perdido ou o serviço migrar de máquina, a lista de alunos
 * continua existindo em algum lugar que você controla.
 *
 * IMPORTANTE: são dados pessoais (telefone, nome, aniversário). Aponte
 * GITHUB_REPO para um repositório PRIVADO. Sem as variáveis configuradas o
 * módulo fica desligado e o app funciona normalmente só com o volume.
 */

const TOKEN  = process.env.GITHUB_TOKEN || '';
const REPO   = process.env.GITHUB_REPO || '';          // 'usuario/repositorio'
const CAMINHO = process.env.GITHUB_PATH || 'teamrausch/alunos.json';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const ESPERA = Number(process.env.GITHUB_DEBOUNCE_MS || 8000);

const ligado = Boolean(TOKEN && REPO);

let agendado = null;   // timer do debounce
let enviando = false;  // trava: um envio por vez
let denovo = false;    // chegou mudança enquanto enviava
let ultimoErro = null;
let ultimoEnvio = null;

function log(...a) { console.log('[alunos-github]', ...a); }

async function chamar(url, opcoes = {}) {
  const r = await fetch(url, {
    ...opcoes,
    headers: {
      Authorization: `token ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'teamrausch-app',
      ...(opcoes.headers || {}),
    },
  });
  const corpo = await r.json().catch(() => ({}));
  return { status: r.status, corpo };
}

/**
 * O SHA precisa ser buscado imediatamente antes do PUT. Se outra escrita
 * entrar no meio, o GitHub devolve 409 e a alteração se perderia.
 */
async function shaAtual() {
  const url = `https://api.github.com/repos/${REPO}/contents/${encodeURI(CAMINHO)}?ref=${BRANCH}`;
  const { status, corpo } = await chamar(url);
  if (status === 200) return corpo.sha;
  if (status === 404) return null;          // primeiro envio
  throw new Error(`GET ${status}: ${corpo.message || 'falha ao ler o arquivo'}`);
}

async function enviar(conteudo, tentativa = 1) {
  const sha = await shaAtual();
  const url = `https://api.github.com/repos/${REPO}/contents/${encodeURI(CAMINHO)}`;
  const { status, corpo } = await chamar(url, {
    method: 'PUT',
    body: JSON.stringify({
      message: `Alunos do estúdio — ${new Date().toISOString()}`,
      content: Buffer.from(conteudo, 'utf8').toString('base64'),
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });

  if (status === 200 || status === 201) return true;

  // 409 é sempre SHA velho: alguém gravou entre o GET e o PUT. Tenta de novo.
  if (status === 409 && tentativa < 3) {
    await new Promise((r) => setTimeout(r, 400 * tentativa));
    return enviar(conteudo, tentativa + 1);
  }
  throw new Error(`PUT ${status}: ${corpo.message || 'falha ao gravar'}`);
}

/** Monta o JSON publicado. Só campos de ficha — nada de sessão ou código. */
function montar(alunos) {
  return JSON.stringify({
    atualizadoEm: new Date().toISOString(),
    total: alunos.length,
    alunos: alunos.map((a) => ({
      telefone: a.telefone,
      nome: a.nome || null,
      aniversario: a.aniversario || null,   // 'MM-DD'
      criadoEm: a.criadoEm || null,
      ultimoAcesso: a.ultimoAcesso || null,
      bloqueado: Boolean(a.bloqueado),
    })),
  }, null, 2);
}

/**
 * Pede um envio. Várias chamadas seguidas viram um envio só — cadastrar cinco
 * alunos em sequência não deve gerar cinco commits.
 */
function sincronizar(listarAlunos) {
  if (!ligado) return;
  if (agendado) return;

  agendado = setTimeout(async () => {
    agendado = null;
    if (enviando) { denovo = true; return; }

    enviando = true;
    try {
      await enviar(montar(listarAlunos()));
      ultimoEnvio = new Date().toISOString();
      ultimoErro = null;
    } catch (erro) {
      ultimoErro = erro.message;
      log('falhou:', erro.message);
    } finally {
      enviando = false;
      if (denovo) { denovo = false; sincronizar(listarAlunos); }
    }
  }, ESPERA);
  if (agendado.unref) agendado.unref();
}

function situacao() {
  return { ligado, repo: ligado ? REPO : null, caminho: ligado ? CAMINHO : null, ultimoEnvio, ultimoErro };
}

if (ligado) log(`backup ligado: ${REPO}/${CAMINHO} (${BRANCH})`);
else log('backup desligado — defina GITHUB_TOKEN e GITHUB_REPO para ativar.');

module.exports = { sincronizar, situacao, ligado };
