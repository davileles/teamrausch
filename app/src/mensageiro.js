'use strict';

const config = require('./config');

/** Preenche {{marcadores}} num texto. */
function preencher(modelo, valores) {
  return String(modelo || '').replace(/\{\{(\w+)\}\}/g, (_, chave) =>
    valores[chave] === undefined ? '' : String(valores[chave]));
}

/**
 * Envia o código pelo canal configurado.
 * O mesmo POST HTTP atende o servidor Baileys e qualquer provedor de SMS —
 * muda só a URL, o token e o formato do corpo.
 */
async function enviarCodigo(telefone, codigo) {
  const c = config.ler();
  const minutos = c.acesso.minutosDeValidadeDoCodigo;
  const mensagem = preencher(c.envio.texto, { codigo, minutos });

  // No canal aberto ninguém deveria chegar aqui, mas se chegar (é o caso do
  // administrador, que continua precisando de código), o código vai para o log.
  if (c.acesso.canalDoCodigo === 'log' || c.acesso.canalDoCodigo === 'aberto' || !c.envio.url) {
    console.log(`[codigo] ${telefone} → ${codigo} (canal em modo log)`);
    return { ok: true, canal: 'log' };
  }

  const cabecalhos = { 'Content-Type': 'application/json' };
  if (c.envio.token) {
    const nome = c.envio.nomeDoCabecalhoDoToken || 'Authorization';
    cabecalhos[nome] = nome.toLowerCase() === 'authorization' && !/^Bearer /i.test(c.envio.token)
      ? `Bearer ${c.envio.token}`
      : c.envio.token;
  }

  const corpo = preencher(c.envio.corpo, {
    telefone,
    mensagem: mensagem.replace(/"/g, '\\"').replace(/\n/g, '\\n'),
    codigo,
  });

  const controle = new AbortController();
  const t = setTimeout(() => controle.abort(), 10000);
  try {
    const r = await fetch(c.envio.url, {
      method: 'POST', headers: cabecalhos, body: corpo, signal: controle.signal,
    });
    if (!r.ok) {
      const texto = (await r.text().catch(() => '')).slice(0, 200);
      console.error('[codigo] envio recusado:', r.status, texto);
      return {
        ok: false,
        motivo: r.status === 503
          ? 'O envio de códigos está fora do ar. Fale com o estúdio.'
          : 'Não consegui enviar o código agora. Tente de novo em instantes.',
      };
    }
    return { ok: true, canal: c.acesso.canalDoCodigo };
  } catch (erro) {
    console.error('[codigo] falha no envio:', erro.message);
    return { ok: false, motivo: 'Não consegui enviar o código agora.' };
  } finally {
    clearTimeout(t);
  }
}

module.exports = { enviarCodigo, preencher };
