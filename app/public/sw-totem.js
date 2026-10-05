/* sw-totem.js — davileles/teamrausch
 *
 * Service worker do tablet da entrada (`/totem.html`). Guarda a página, o logo
 * e as fontes (`/fonts/*`, servidas pelo próprio app) para o totem abrir igual
 * mesmo com a internet do estúdio fora do ar.
 *
 * ESCOPO SÓ DO TOTEM
 *   Registrado com `scope: '/totem.html'`: o app do aluno (`/`), a recepção e
 *   a TV continuam exatamente como eram, sem cache nenhum no meio.
 *
 * O QUE NÃO PASSA POR AQUI
 *   As rotas `/totem-api/*` e `/tv-api/*` vão direto para a rede. Quem decide
 *   o que fazer quando a rede falha é a própria página (fila offline): um
 *   cache de resposta de API aqui confirmaria presença com dado velho.
 *
 * PÁGINA: REDE PRIMEIRO, CACHE SE A REDE NÃO RESPONDER
 *   Com internet, o tablet sempre pega a versão nova do totem. Sem internet —
 *   inclusive o caso traiçoeiro do Wi-Fi conectado que não sai para lugar
 *   nenhum — espera poucos segundos e abre a cópia guardada.
 */

const VERSAO = 'totem-v2';
// As fontes moram no app (não no Google Fonts) e entram já na instalação:
// sem elas, a cópia guardada abria com a fonte padrão do sistema.
const ESSENCIAIS = [
  '/totem.html', '/logo.png', '/favicon.png',
  '/fonts/anton-latin.woff2', '/fonts/anton-latin-ext.woff2',
  '/fonts/work-sans-latin.woff2', '/fonts/work-sans-latin-ext.woff2',
];
const ESPERA_REDE_MS = 4000;

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    caches.open(VERSAO)
      .then((c) => c.addAll(ESSENCIAIS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((nomes) => Promise.all(nomes
        .filter((n) => n.startsWith('totem-') && n !== VERSAO)
        .map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

/** fetch com prazo: Wi-Fi sem internet às vezes nem recusa, só fica pendurado. */
function comPrazo(req, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('prazo')), ms);
    fetch(req).then((r) => { clearTimeout(t); resolve(r); },
      (e) => { clearTimeout(t); reject(e); });
  });
}

async function paginaDoTotem(req) {
  const cache = await caches.open(VERSAO);
  try {
    const r = await comPrazo(req, ESPERA_REDE_MS);
    if (r && r.ok) {
      cache.put('/totem.html', r.clone());
      return r;
    }
    const guardada = await cache.match('/totem.html');
    return guardada || r;
  } catch (e) {
    const guardada = await cache.match('/totem.html');
    if (guardada) return guardada;
    throw e;
  }
}

/** Logo, ícone e fontes: responde do cache na hora e atualiza por trás. */
async function guardadoPrimeiro(req) {
  const cache = await caches.open(VERSAO);
  const guardada = await cache.match(req);
  const daRede = fetch(req)
    .then((r) => {
      if (r && (r.ok || r.type === 'opaque')) cache.put(req, r.clone());
      return r;
    })
    .catch(() => null);
  if (guardada) return guardada;
  const r = await daRede;
  if (r) return r;
  return new Response('', { status: 504, statusText: 'Sem internet' });
}

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/totem-api/') || url.pathname.startsWith('/tv-api/')) return;
    if (req.mode === 'navigate' && url.pathname === '/totem.html') {
      ev.respondWith(paginaDoTotem(req));
      return;
    }
    if (url.pathname === '/logo.png' || url.pathname === '/favicon.png'
      || url.pathname.startsWith('/fonts/')) {
      ev.respondWith(guardadoPrimeiro(req));
    }
  }
});
