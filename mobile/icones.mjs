// icones.mjs — monta as imagens-fonte de ícone e abertura do app a partir do
// app/public/logo.png (escudo Team Rausch: ícone sobre cinza claro, abertura no preto). Depois o
// @capacitor/assets gera todos os tamanhos de Android e iOS (npm run icones).
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const LOGO = join(AQUI, '..', 'app', 'public', 'logo.png');
const OUT = join(AQUI, 'assets');
const PRETO = '#0E0F11';
// Fundo do ícone: cinza claro da paleta do app (--linha do tema claro). O
// escudo tem contorno escuro próprio e fica mais amigável no claro que no preto.
const CINZA = '#D6DAE0';
mkdirSync(OUT, { recursive: true });

const fundo = (lado, cor) => sharp({ create: { width: lado, height: lado, channels: 4, background: cor } });
// O logo.png tem uma linha cinza solta na borda esquerda e um véu quase
// transparente em volta: corta 3 px de cada lado e zera o alfa abaixo de 24.
async function logoLimpo() {
  const meta = await sharp(LOGO).metadata();
  const { data, info } = await sharp(LOGO).ensureAlpha()
    .extract({ left: 3, top: 3, width: meta.width - 6, height: meta.height - 6 })
    .raw().toBuffer({ resolveWithObject: true });
  for (let i = 3; i < data.length; i += 4) if (data[i] < 24) data[i] = 0;
  return sharp(data, { raw: info }).trim({ threshold: 0 }).png().toBuffer();
}
const LOGO_LIMPO = await logoLimpo();
// O logo não é quadrado (~1,1:1): cabe numa caixa quadrada, centralizado.
const logo = (lado) => sharp(LOGO_LIMPO).resize(lado, lado, { fit: 'contain', background: '#00000000', kernel: 'lanczos3' }).png().toBuffer();

async function comLogo(lado, cor, proporcao, arquivo) {
  const l = Math.round(lado * proporcao);
  const off = Math.round((lado - l) / 2);
  await fundo(lado, cor).composite([{ input: await logo(l), left: off, top: off }]).png().toFile(join(OUT, arquivo));
}

await comLogo(1024, CINZA, 0.80, 'icon-only.png');             // iOS (sem transparência)
await comLogo(1024, '#00000000', 0.60, 'icon-foreground.png'); // Android adaptativo
await fundo(1024, CINZA).png().toFile(join(OUT, 'icon-background.png'));
await comLogo(2732, PRETO, 0.24, 'splash.png');
await comLogo(2732, PRETO, 0.24, 'splash-dark.png');
console.log('icones: assets/ pronto');
