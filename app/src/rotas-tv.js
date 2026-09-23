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

module.exports = { rotas };
