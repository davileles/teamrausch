'use strict';

/**
 * app/src/backup-github.js — davileles/teamrausch
 *
 * Backup de um arquivo JSON num repositório do GitHub, com debounce, trava de
 * envio único e releitura do SHA imediatamente antes de cada PUT.
 *
 * É a mesma mecânica de `alunos-github.js`, mas parametrizada pelo caminho:
 * `alunos-github.js` continua existindo intocado (cuida de `alunos.json`) e
 * este módulo atende qualquer outro arquivo — hoje `matriculas.json`.
 *
 * O volume do Railway continua sendo a fonte de verdade. Isto aqui é a rede de
 * proteção: se o volume sumir ou o serviço migrar de máquina, a base continua
 * existindo num lugar que você controla.
 *
 * IMPORTANTE: são dados pessoais. Aponte GITHUB_REPO para um repositório
 * PRIVADO. Sem as variáveis configuradas o módulo fica desligado e o app roda
 * normalmente só com o volume.
 */

const TOKEN  = process.env.GITHUB_TOKEN || '';
const REPO   = process.env.GITHUB_REPO || '';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const ESPERA = Number(process.env.GITHUB_DEBOUNCE_MS || 8000);

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
 * @param {string} caminho  'teamrausch/matriculas.json'
 * @param {string} rotulo   aparece no log e na mensagem do commit
 */
function criar(caminho, rotulo) {
  const ligado = Boolean(TOKEN && REPO);

  let agendado = null;   // timer do debounce
  let enviando = false;  // trava: um envio por vez
  let denovo = false;    // chegou mudança enquanto enviava
  let ultimoErro = null;
  let ultimoEnvio = null;

  function log(...a) { console.log(`[backup:${rotulo}]`, ...a); }

  /**
   * O SHA precisa ser buscado imediatamente antes do PUT. Se outra escrita
   * entrar no meio, o GitHub devolve 409 e a alteração se perderia.
   */
  async function shaAtual() {
    const url = `https://api.github.com/repos/${REPO}/contents/${encodeURI(caminho)}?ref=${BRANCH}`;
    const { status, corpo } = await chamar(url);
    if (status === 200) return corpo.sha;
    if (status === 404) return null;          // primeiro envio
    throw new Error(`GET ${status}: ${corpo.message || 'falha ao ler o arquivo'}`);
  }

  async function enviar(conteudo, tentativa = 1) {
    const sha = await shaAtual();
    const url = `https://api.github.com/repos/${REPO}/contents/${encodeURI(caminho)}`;
    const { status, corpo } = await chamar(url, {
      method: 'PUT',
      body: JSON.stringify({
        message: `${rotulo} — ${new Date().toISOString()}`,
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

  /** Lê o arquivo do GitHub. Devolve null quando não existe ou o módulo está desligado. */
  async function baixar() {
    if (!ligado) return null;
    const url = `https://api.github.com/repos/${REPO}/contents/${encodeURI(caminho)}?ref=${BRANCH}`;
    const { status, corpo } = await chamar(url);
    if (status === 404) return null;
    if (status !== 200) throw new Error(`GET ${status}: ${corpo.message || 'falha ao ler'}`);
    // Arquivo acima de 1 MB volta com `encoding: none` e `content` vazio.
    if (corpo.encoding !== 'base64' || !corpo.content) {
      const r = await fetch(corpo.download_url, { headers: { Authorization: `token ${TOKEN}` } });
      if (!r.ok) throw new Error(`download ${r.status}`);
      return JSON.parse(await r.text());
    }
    return JSON.parse(Buffer.from(corpo.content, 'base64').toString('utf8'));
  }

  /**
   * Pede um envio. Várias chamadas seguidas viram um envio só — editar cinco
   * matrículas em sequência não deve gerar cinco commits.
   *
   * @param {Function} montar  função sem argumentos que devolve o texto a gravar
   */
  function sincronizar(montar) {
    if (!ligado) return;
    if (agendado) return;

    agendado = setTimeout(async () => {
      agendado = null;
      if (enviando) { denovo = true; return; }

      enviando = true;
      try {
        await enviar(montar());
        ultimoEnvio = new Date().toISOString();
        ultimoErro = null;
      } catch (erro) {
        ultimoErro = erro.message;
        log('falhou:', erro.message);
      } finally {
        enviando = false;
        if (denovo) { denovo = false; sincronizar(montar); }
      }
    }, ESPERA);
    if (agendado.unref) agendado.unref();
  }

  function situacao() {
    return {
      ligado,
      repo: ligado ? REPO : null,
      caminho: ligado ? caminho : null,
      ultimoEnvio,
      ultimoErro,
    };
  }

  if (ligado) log(`ligado: ${REPO}/${caminho} (${BRANCH})`);
  else log('desligado — defina GITHUB_TOKEN e GITHUB_REPO para ativar.');

  return { sincronizar, baixar, situacao, ligado };
}

module.exports = { criar };
