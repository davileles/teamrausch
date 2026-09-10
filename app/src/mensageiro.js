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

/**
 * Envia um texto livre para um telefone, pelo mesmo canal do código de acesso.
 *
 * Existe porque a cobrança de frequência precisa falar com o ALUNO, e não com
 * as listas de aviso do estúdio — `poller-portal.enviarWhatsApp` manda para
 * quem está em Configurações → Avisos de check-in, que é outra coisa.
 * Reaproveita `config.envio` (url, token e formato do corpo) para não haver um
 * segundo lugar onde configurar o WhatsApp.
 */
async function enviarTexto(telefone, mensagem, opcoes = {}) {
  const c = config.ler();
  const numero = String(telefone || '').replace(/\D/g, '');
  const anexo = opcoes.anexo || null;
  if (!numero) return { ok: false, motivo: 'Aluno sem telefone cadastrado.' };
  if (!c.envio.url) return { ok: false, motivo: 'Endereço do serviço de WhatsApp não configurado.' };

  const cabecalhos = { 'Content-Type': 'application/json' };
  if (c.envio.token) {
    const nome = c.envio.nomeDoCabecalhoDoToken || 'Authorization';
    cabecalhos[nome] = nome.toLowerCase() === 'authorization' && !/^Bearer /i.test(c.envio.token)
      ? `Bearer ${c.envio.token}`
      : c.envio.token;
  }

  // O corpo é um molde de texto com {{marcadores}}, então a mensagem precisa
  // entrar já escapada para JSON: uma aspa ou uma quebra de linha crua
  // quebraria o corpo inteiro e o envio voltaria 400.
  let corpo = preencher(c.envio.corpo, {
    telefone: numero,
    mensagem: String(mensagem || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n'),
    codigo: '',
  });

  // ANEXO ENTRA COMO CAMPO A MAIS NO MESMO CORPO
  //   O molde de Configurações → Técnica continua mandando no formato; o anexo
  //   é acrescentado depois de preenchido. Por isso o molde precisa ser JSON:
  //   um provedor de SMS com corpo em outro formato não tem onde pôr arquivo,
  //   e é melhor recusar do que mandar só o texto fingindo que foi tudo.
  if (anexo) {
    let objeto;
    try { objeto = JSON.parse(corpo); } catch (_) { objeto = null; }
    if (!objeto || typeof objeto !== 'object') {
      return { ok: false, motivo: 'O corpo do envio (Configurações → Técnica) não é JSON: anexo só funciona com o serviço de WhatsApp do estúdio.' };
    }
    objeto.anexo = {
      base64: anexo.buffer.toString('base64'),
      mimetype: anexo.tipo,
      nome: anexo.nome,
    };
    corpo = JSON.stringify(objeto);
  }

  const controle = new AbortController();
  // Com arquivo o serviço de WhatsApp ainda precisa subir a mídia para o
  // servidor do WhatsApp antes de responder — 10 s não bastam para um PDF grande.
  const t = setTimeout(() => controle.abort(), anexo ? 90000 : 10000);
  try {
    const r = await fetch(c.envio.url, {
      method: 'POST', headers: cabecalhos, body: corpo, signal: controle.signal,
    });
    if (!r.ok) {
      const texto = (await r.text().catch(() => '')).slice(0, 200);
      return { ok: false, motivo: `Envio recusado (HTTP ${r.status}): ${texto}` };
    }
    return { ok: true };
  } catch (erro) {
    return { ok: false, motivo: erro.name === 'AbortError' ? 'O serviço de WhatsApp não respondeu a tempo.' : erro.message };
  } finally {
    clearTimeout(t);
  }
}

module.exports = { enviarCodigo, enviarTexto, preencher };
