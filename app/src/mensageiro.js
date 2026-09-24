'use strict';

const config = require('./config');

/* ------------------------------------------------------------------------- *
 *  POST AO SERVIÇO DE WHATSAPP, COM NOVA TENTATIVA SEGURA
 *
 *  O serviço de WhatsApp (pasta whatsapp/) reinicia de vez em quando — deploy,
 *  queda do Baileys. Nessa janela o proxy do Railway devolve 502/503 com
 *  "upstream connect error ...". Antes a mensagem se perdia ali.
 *
 *  Regra para não mandar duas vezes ao aluno:
 *    - repete quando é CERTO que nada saiu: erro de rede antes da resposta
 *      (conexão recusada/caída), resposta do proxy sem o serviço (texto não
 *      JSON em 502/503/504) ou o próprio serviço dizendo podeRepetir=true;
 *    - NÃO repete quando o serviço diz podeRepetir=false (envio ambíguo) nem
 *      quando o nosso prazo estourou (o serviço pode ter enviado depois).
 * ------------------------------------------------------------------------- */
const ESPERAS_ENTRE_TENTATIVAS = [3000, 8000]; // 3 tentativas no total
const REDE_REPETIVEL = ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET'];

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lê a resposta de erro: JSON do nosso serviço ou texto do proxy do Railway. */
function lerFalha(status, texto) {
  let json = null;
  try { json = JSON.parse(texto); } catch (_) { json = null; }
  if (json && typeof json === 'object' && (json.erro || json.error)) {
    const repetir = typeof json.podeRepetir === 'boolean' ? json.podeRepetir : status === 503;
    return { motivo: `${json.erro || json.error} (HTTP ${status})`, repetir };
  }
  const proxy = /upstream connect error|no healthy upstream|application failed to respond|connection termination|bad gateway|service unavailable/i.test(texto);
  if (proxy || [502, 503, 504].includes(status)) {
    return { motivo: `Serviço de WhatsApp fora do ar ou reiniciando (HTTP ${status}).`, repetir: [502, 503, 504].includes(status) };
  }
  return { motivo: `Envio recusado (HTTP ${status}): ${String(texto || '').slice(0, 200)}`, repetir: false };
}

/**
 * Faz o POST com até 3 tentativas. Devolve
 *   { ok, status, corpo, motivo, tentativas, erroRede }
 * sem lançar exceção.
 */
async function postarWhatsApp(url, { headers, body, timeoutMs = 10000 }) {
  let ultimo = null;
  for (let i = 0; i <= ESPERAS_ENTRE_TENTATIVAS.length; i++) {
    if (i > 0) await dormir(ESPERAS_ENTRE_TENTATIVAS[i - 1]);
    const controle = new AbortController();
    const t = setTimeout(() => controle.abort(), timeoutMs);
    let repetir = false;
    try {
      const r = await fetch(url, { method: 'POST', headers, body, signal: controle.signal });
      const corpo = await r.text().catch(() => '');
      if (r.ok) return { ok: true, status: r.status, corpo, tentativas: i + 1 };
      const falha = lerFalha(r.status, corpo);
      ultimo = { ok: false, status: r.status, corpo: corpo.slice(0, 200), motivo: falha.motivo };
      repetir = falha.repetir;
    } catch (erro) {
      const codigo = erro.cause && (erro.cause.code || erro.cause.errno);
      if (erro.name === 'AbortError') {
        // Pode ter saído depois do nosso prazo: repetir arriscaria duplicar.
        ultimo = { ok: false, status: null, motivo: 'O serviço de WhatsApp não respondeu a tempo.', erroRede: erro };
        repetir = false;
      } else {
        ultimo = { ok: false, status: null, motivo: `Sem conexão com o serviço de WhatsApp (${codigo || erro.message}).`, erroRede: erro };
        repetir = REDE_REPETIVEL.includes(codigo) || erro.message === 'fetch failed';
      }
    } finally {
      clearTimeout(t);
    }
    ultimo.tentativas = i + 1;
    if (!repetir) break;
    if (i < ESPERAS_ENTRE_TENTATIVAS.length) {
      console.warn(`[whatsapp] tentativa ${i + 1} falhou (${ultimo.motivo}); tentando de novo.`);
    }
  }
  if (ultimo.tentativas > 1) ultimo.motivo = `${ultimo.motivo.replace(/\.$/, '')} — ${ultimo.tentativas} tentativas.`;
  return ultimo;
}

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

  const r = await postarWhatsApp(c.envio.url, { headers: cabecalhos, body: corpo, timeoutMs: 10000 });
  if (r.ok) return { ok: true, canal: c.acesso.canalDoCodigo };
  console.error('[codigo] envio falhou:', r.motivo);
  if (r.status == null) return { ok: false, motivo: 'Não consegui enviar o código agora.' };
  return {
    ok: false,
    motivo: r.status === 503
      ? 'O envio de códigos está fora do ar. Fale com o estúdio.'
      : 'Não consegui enviar o código agora. Tente de novo em instantes.',
  };
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

  // Com arquivo o serviço de WhatsApp ainda precisa subir a mídia para o
  // servidor do WhatsApp antes de responder — 10 s não bastam para um PDF grande.
  // 30 s para texto cobre a espera pela reconexão e a fila do serviço.
  const r = await postarWhatsApp(c.envio.url, { headers: cabecalhos, body: corpo, timeoutMs: anexo ? 90000 : 30000 });
  if (r.ok) return { ok: true, tentativas: r.tentativas };
  console.warn(`[whatsapp] não saiu para ${numero}: ${r.motivo}`);
  return { ok: false, motivo: r.motivo };
}

module.exports = { enviarCodigo, enviarTexto, preencher, postarWhatsApp };
