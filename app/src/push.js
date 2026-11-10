// ═══════════════════════════════════════════════════════════════════════════
// push.js — notificação push no app do Team Rausch (pasta mobile/).
//
// iPhone: direto na Apple (APNs, HTTP/2, chave .p8). Não usa Firebase nem
// serviço de terceiros. A chave de push (APNs) vale para todos os apps da
// mesma conta Apple: é a mesma que o proxy do CDV usa.
//   APNS_KEY_P8       conteúdo do arquivo AuthKey_XXXX.p8 (com BEGIN/END)
//   APNS_KEY_ID       ID da chave (10 caracteres)
//   APNS_TEAM_ID      Team ID da conta Apple (cai em APPLE_TEAM_ID se faltar)
//   APNS_BUNDLE_ID    padrão br.com.teamrausch.app
//   APNS_AMBIENTE     production (TestFlight e App Store) | sandbox
// Android: ainda sem push (precisaria do Firebase). O app não registra lá.
//
// Sem as variáveis, o envio é pulado em silêncio. Quem guarda os tokens dos
// celulares é dispositivos.js.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const crypto = require('crypto');
const http2 = require('http2');

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function cfgApns() {
  const p8 = (process.env.APNS_KEY_P8 || '').replace(/\\n/g, '\n').trim();
  const keyId = (process.env.APNS_KEY_ID || '').trim();
  const teamId = (process.env.APNS_TEAM_ID || process.env.APPLE_TEAM_ID || '').trim();
  if (!p8 || !keyId || !teamId) return null;
  return {
    p8, keyId, teamId,
    bundle: (process.env.APNS_BUNDLE_ID || 'br.com.teamrausch.app').trim(),
    host: (process.env.APNS_AMBIENTE || 'production') === 'sandbox'
      ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com',
  };
}

// O JWT da Apple vale 1 h; renova a cada 40 min.
let _jwt = { valor: '', ts: 0 };
function jwtApns(cfg) {
  if (_jwt.valor && Date.now() - _jwt.ts < 40 * 60 * 1000) return _jwt.valor;
  const cab = b64url(JSON.stringify({ alg: 'ES256', kid: cfg.keyId }));
  const corpo = b64url(JSON.stringify({ iss: cfg.teamId, iat: Math.floor(Date.now() / 1000) }));
  const assinatura = crypto.sign('sha256', Buffer.from(cab + '.' + corpo), { key: cfg.p8, dsaEncoding: 'ieee-p1363' });
  _jwt = { valor: cab + '.' + corpo + '.' + b64url(assinatura), ts: Date.now() };
  return _jwt.valor;
}

function enviarApns(token, msg) {
  const cfg = cfgApns();
  if (!cfg) return Promise.resolve({ ok: false, pulado: true, motivo: 'apns_sem_config' });
  return new Promise((resolve) => {
    let sessao;
    const fim = (r) => { try { if (sessao) sessao.close(); } catch (e) { /* já fechou */ } resolve(r); };
    try {
      sessao = http2.connect(cfg.host);
      sessao.on('error', (e) => fim({ ok: false, motivo: 'conexao: ' + e.message }));
      const payload = JSON.stringify({
        aps: { alert: { title: msg.titulo, body: msg.corpo }, sound: 'default', 'thread-id': msg.grupo || 'estudio' },
        ...(msg.dados || {}),
      });
      const req = sessao.request({
        ':method': 'POST',
        ':path': '/3/device/' + token,
        authorization: 'bearer ' + jwtApns(cfg),
        'apns-topic': cfg.bundle,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json',
      });
      let status = 0, resp = '';
      req.setTimeout(15000, () => { req.close(); fim({ ok: false, motivo: 'timeout' }); });
      req.on('response', (h) => { status = h[':status']; });
      req.on('data', (d) => { resp += d; });
      req.on('end', () => {
        if (status === 200) return fim({ ok: true });
        let razao = '';
        try { razao = JSON.parse(resp).reason || ''; } catch (e) { /* sem corpo */ }
        // 410 = app desinstalado; BadDeviceToken = token de outro ambiente ou lixo.
        const invalido = status === 410 || razao === 'BadDeviceToken' || razao === 'Unregistered';
        fim({ ok: false, invalido, motivo: 'apns ' + status + ' ' + razao });
      });
      req.on('error', (e) => fim({ ok: false, motivo: 'apns: ' + e.message }));
      req.end(payload);
    } catch (e) {
      fim({ ok: false, motivo: 'apns: ' + e.message });
    }
  });
}

function pushConfigurado() {
  return { ios: !!cfgApns(), android: false };
}

// msg = { titulo, corpo, dados?: { aba }, grupo? }
function enviarPush(plataforma, token, msg) {
  if (!token) return Promise.resolve({ ok: false, motivo: 'sem_token' });
  if (plataforma !== 'ios') return Promise.resolve({ ok: false, pulado: true, motivo: 'android_sem_push' });
  return enviarApns(token, msg);
}

module.exports = { enviarPush, pushConfigurado };
