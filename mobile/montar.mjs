// ═══════════════════════════════════════════════════════════════════════════
// montar.mjs — gera mobile/www (o que vai dentro do app) a partir do sistema.
//
// O app NÃO tem cópia própria das telas: a cada compilação ele pega o
// app/public/index.html (aluno + admin) e os arquivos que ele usa, e:
//   • faz as chamadas /agenda-api irem para app.teamrausch.com.br (o app roda
//     em capacitor://localhost, não no domínio do estúdio);
//   • troca o Google Fonts pelas fontes do próprio sistema (app/public/fonts),
//     para o app abrir com a fonte certa mesmo sem internet;
//   • manda o link do mural (tv.html) para o site;
//   • injeta capacitor-plugins.js + nativo.js + nativo.css no <head>.
// Qualquer mudança no sistema entra no app na próxima compilação.
//
// Uso: node montar.mjs   (rodado pelos workflows app-android.yml / app-ios.yml)
// ═══════════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const PUBLICO = join(AQUI, '..', 'app', 'public');
const WWW = join(AQUI, 'www');
const SITE = 'https://app.teamrausch.com.br';
const pkg = JSON.parse(readFileSync(join(AQUI, 'package.json'), 'utf8'));
const VERSAO = process.env.VERSAO_APP || pkg.version;

function trocar(texto, antigo, novo, nome, vezes = 1) {
  const n = texto.split(antigo).length - 1;
  if (n !== vezes) throw new Error(`montar: esperava ${vezes} ocorrência(s) de ${nome}, achei ${n}. O index.html mudou — ajuste mobile/montar.mjs.`);
  return texto.split(antigo).join(novo);
}

rmSync(WWW, { recursive: true, force: true });
mkdirSync(join(WWW, 'fonts'), { recursive: true });

// 1) Arquivos do sistema usados pelo index.html
for (const arq of ['logo.png', 'favicon.png']) {
  const origem = join(PUBLICO, arq);
  if (!existsSync(origem)) throw new Error(`montar: falta app/public/${arq}`);
  copyFileSync(origem, join(WWW, arq));
}
for (const f of readdirSync(join(PUBLICO, 'fonts'))) {
  if (f.endsWith('.woff2')) copyFileSync(join(PUBLICO, 'fonts', f), join(WWW, 'fonts', f));
}

// 2) Capacitor sem bundler: core + plugins em build IIFE, num arquivo só
const MODS = ['core/dist/capacitor.js', 'app', 'browser', 'share', 'status-bar', 'splash-screen', 'haptics', 'preferences', 'push-notifications']
  .map((m) => '@capacitor/' + (m.includes('/') ? m : `${m}/dist/plugin.js`));
// Plugin de terceiros (build IIFE em dist/plugin.js): Face ID/digital.
MODS.push('@capgo/capacitor-native-biometric/dist/plugin.js');
const bundle = MODS.map((m) => {
  const cod = readFileSync(join(AQUI, 'node_modules', m), 'utf8').replace(/\/\/# sourceMappingURL=.*$/gm, '');
  return `/* ── ${m} ── */\n${cod}`;
}).join('\n;\n');
writeFileSync(join(WWW, 'capacitor-plugins.js'), bundle);

// 3) Ponte nativa
writeFileSync(join(WWW, 'nativo.js'), readFileSync(join(AQUI, 'src/nativo.js'), 'utf8').replace('__VERSAO_APP__', VERSAO));
copyFileSync(join(AQUI, 'src/nativo.css'), join(WWW, 'nativo.css'));

// 4) Fontes locais: as mesmas @font-face do totem.html (que já roda offline)
const totem = readFileSync(join(PUBLICO, 'totem.html'), 'utf8');
const faces = totem.match(/@font-face\{[\s\S]*?\}/g) || [];
if (faces.length < 4) throw new Error(`montar: esperava as 4 @font-face no totem.html, achei ${faces.length}`);
writeFileSync(join(WWW, 'fontes.css'), faces.join('\n').replace(/url\(\/fonts\//g, 'url(fonts/') + '\n');

// 5) index.html adaptado
let h = readFileSync(join(PUBLICO, 'index.html'), 'utf8');
h = trocar(h,
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
  '<script src="capacitor-plugins.js"></script>\n<script src="nativo.js"></script>\n' +
  '<link rel="stylesheet" href="nativo.css">',
  'meta viewport');
h = trocar(h,
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' +
  '<link href="https://fonts.googleapis.com/css2?family=Anton&family=Work+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">',
  '<link rel="stylesheet" href="fontes.css">',
  'Google Fonts');
h = trocar(h, "fetch('/agenda-api", `fetch('${SITE}/agenda-api`, "fetch('/agenda-api", 2);
h = trocar(h, 'href="/tv.html"', `href="${SITE}/tv.html"`, 'link do mural');
h = trocar(h, 'src="/logo.png"', 'src="logo.png"', 'logo', 2);
h = trocar(h, 'href="/favicon.png"', 'href="favicon.png"', 'favicon', 2);
writeFileSync(join(WWW, 'index.html'), h);

console.log(`montar: www/ pronto (app ${VERSAO}, index.html ${(h.length / 1024).toFixed(0)} KB)`);
