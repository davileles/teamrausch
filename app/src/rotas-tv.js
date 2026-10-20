'use strict';

/**
 * app/src/rotas-tv.js — davileles/teamrausch
 *
 * Rotas do mural da TV (`/tv.html`) e do botão "Ligar TV" do tablet.
 *
 * Abertas, como as do totem: a TV é um Chromecast que só sabe abrir um
 * endereço, e o feed não entrega nada além de primeiro nome e inicial.
 */

const express = require('express');
const config = require('./config');
const mural = require('./mural-tv');

const rotas = express.Router();

rotas.get('/feed', (_req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(mural.feed());
  } catch (e) {
    console.error('[mural-tv] feed falhou:', e.message);
    res.status(500).json({ erro: 'Não consegui montar o mural.' });
  }
});

/** Por que um ranking não apareceu — só contagens, sem nomes. */
rotas.get('/diagnostico', (_req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(mural.diagnostico());
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/** O que o tablet precisa para mostrar o botão de ligar a TV. */
rotas.get('/cast', (_req, res) => {
  let m = {};
  try { m = config.ler().mural || {}; } catch (e) { m = {}; }
  res.set('Cache-Control', 'no-store');
  res.json({ appId: String(m.castAppId || '').trim() || null, ativo: m.ativo !== false });
});

/* Diário do receptor do Chromecast: guarda os últimos eventos em memória e
   repete no log do Railway (prefixo [tv-log]). Só eventos técnicos, sem
   dado de aluno. GET /tv-api/log mostra o histórico desde o último deploy. */
const DIARIO = [];
const DIARIO_MAX = 500;
rotas.post('/log', express.text({ type: '*/*', limit: '4kb' }), (req, res) => {
  let ev = {};
  try { ev = JSON.parse(typeof req.body === 'string' ? req.body : '{}') || {}; } catch (e) { ev = {}; }
  const quando = new Date(Date.now() - 3 * 3600 * 1000).toISOString().replace('Z', '-03:00');
  const linha = {
    quando,
    evento: String(ev.evento || '?').slice(0, 60),
    segundosNoAr: Number(ev.segundos) || 0,
    extra: ev.extra == null ? null : (JSON.stringify(ev.extra).length > 500 ? JSON.stringify(ev.extra).slice(0, 500) : ev.extra),
  };
  DIARIO.push(linha);
  if (DIARIO.length > DIARIO_MAX) DIARIO.splice(0, DIARIO.length - DIARIO_MAX);
  if (linha.evento !== 'vivo') console.log('[tv-log]', linha.quando, linha.evento, 'no ar há', linha.segundosNoAr + 's', linha.extra == null ? '' : JSON.stringify(linha.extra));
  res.status(204).end();
});

rotas.get('/log', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(DIARIO.slice().reverse());
});

module.exports = { rotas };
