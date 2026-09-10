'use strict';

/**
 * app/src/rotas-mensagens.js — davileles/teamrausch
 *
 * Endpoints do módulo de mensagens. Tudo aqui é de administrador; montado em
 * `rotas-agenda.js` sob /agenda-api/mensagens, reaproveitando os middlewares
 * de sessão que já existem lá.
 *
 * O ENVIO É UM POR CHAMADA, DE PROPÓSITO
 *   O disparo em massa é conduzido pela tela: ela chama `POST /enviar` uma vez
 *   por aluno, com o intervalo entre uma chamada e outra. Mandar a lista
 *   inteira num POST só faria a requisição ficar pendurada por vinte minutos,
 *   e qualquer timeout de proxy no meio derrubaria o lote sem dizer até onde
 *   tinha ido. Uma chamada por aluno dá registro imediato de cada envio — e é
 *   isso que permite retomar um lote interrompido.
 */

const express = require('express');
const modelos = require('./mensagens-store');
const destinatarios = require('./destinatarios');
const { enviarTexto } = require('./mensageiro');
const matriculas = require('./matriculas-store');
const telefone = require('./telefone');
const anexos = require('./anexos-store');

module.exports = function criarRotas({ exigirLogin, exigirAdmin }) {
  const rotas = express.Router();
  rotas.use(exigirLogin, exigirAdmin);

  /* ------------------------------ modelos -------------------------------- */

  rotas.get('/modelos', (_req, res) => {
    res.json({
      modelos: modelos.listarModelos(),
      marcadores: destinatarios.MARCADORES,
      publicos: modelos.PUBLICOS,
      gatilhos: modelos.GATILHOS,
    });
  });

  rotas.post('/modelos', (req, res) => {
    const r = modelos.criarModelo(req.body || {});
    if (!r.ok) return res.status(400).json({ erro: r.motivo });
    res.status(201).json(r.modelo);
  });

  rotas.put('/modelos/:id', (req, res) => {
    const r = modelos.atualizarModelo(req.params.id, req.body || {});
    if (!r.ok) return res.status(400).json({ erro: r.motivo });
    res.json(r.modelo);
  });

  rotas.delete('/modelos/:id', (req, res) => {
    const r = modelos.removerModelo(req.params.id);
    if (!r.ok) return res.status(404).json({ erro: r.motivo });
    res.json({ removido: true });
  });

  /* --------------------------- destinatários ------------------------------ */

  /**
   * A prévia já vem pronta por aluno. Sem isso a tela teria que repetir a
   * lógica dos marcadores em JavaScript de navegador, e a mensagem enviada
   * poderia sair diferente da que foi mostrada antes de confirmar.
   */
  function responderDestinatarios(fonte, res) {
    const publico = String(fonte.publico || 'todos');
    if (!modelos.PUBLICOS.includes(publico)) {
      return res.status(400).json({ erro: 'Público inválido.' });
    }

    const modelo = fonte.modeloId ? modelos.porId(String(fonte.modeloId)) : null;
    const texto = fonte.texto !== undefined && fonte.texto !== null
      ? String(fonte.texto)
      : (modelo ? modelo.texto : null);

    const opcoes = modelo && modelo.gatilho === 'aniversario'
      ? { aniversarioEm: new Date().toISOString().slice(5, 10) }
      : {};
    // O corte de ausência do modelo precisa valer aqui também: a prévia que
    // mostra 12 nomes e o disparo que manda para 5 seriam a mesma tela
    // mentindo sobre o que vai acontecer.
    if (modelo && modelo.ausenteDias) opcoes.ausenteDias = modelo.ausenteDias;
    if (modelo && modelo.ausenteAte) opcoes.ausenteAte = modelo.ausenteAte;
    const lista = destinatarios.montar(publico, opcoes);

    // Lote em andamento: quem já recebeu não volta para a fila.
    const jaForam = fonte.lote ? new Set(modelos.jaEnviados(String(fonte.lote))) : new Set();

    res.json({
      ...lista,
      alunos: lista.alunos.map((a) => ({
        ...a,
        previa: texto === null ? null : destinatarios.preencher(texto, a),
        jaEnviado: jaForam.has(a.matriculaId),
      })),
    });
  }

  // GET para consulta simples; POST porque o texto livre do disparo em massa
  // não cabe numa querystring — e é ele que gera a prévia de cada aluno.
  rotas.get('/destinatarios', (req, res) => responderDestinatarios(req.query, res));
  rotas.post('/destinatarios', (req, res) => responderDestinatarios(req.body || {}, res));

  /* ------------------------------- anexos -------------------------------- */

  /**
   * O arquivo sobe cru (application/octet-stream), não em JSON: base64 incha
   * 33% e o parser JSON global do app é de 256 KB. Nome e tipo vêm em
   * cabeçalho. Devolve o id que cada POST /enviar cita em `anexoId`.
   */
  const lerArquivo = express.raw({ type: 'application/octet-stream', limit: anexos.LIMITE_BYTES });
  rotas.post('/anexos', (req, res, next) => {
    lerArquivo(req, res, (erro) => {
      if (!erro) return next();
      if (erro.type === 'entity.too.large') return res.status(413).json({ erro: 'Arquivo acima de 16 MB.' });
      return res.status(400).json({ erro: 'Não consegui ler o arquivo.' });
    });
  }, (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ erro: 'Arquivo vazio. Envie como application/octet-stream.' });
    }
    let nome = req.get('X-Anexo-Nome') || '';
    try { nome = decodeURIComponent(nome); } catch (_) { /* fica como veio */ }
    try {
      const r = anexos.salvar(req.body, { nome, tipo: req.get('X-Anexo-Tipo') });
      if (!r.ok) return res.status(400).json({ erro: r.motivo });
      res.status(201).json(r.anexo);
    } catch (e) {
      console.error('[mensagens] falha ao gravar anexo:', e.message);
      res.status(500).json({ erro: 'Não consegui guardar o arquivo no servidor.' });
    }
  });

  /* ------------------------------- envio --------------------------------- */

  rotas.post('/enviar', async (req, res) => {
    const corpo = req.body || {};
    const m = corpo.matriculaId ? matriculas.porId(String(corpo.matriculaId)) : null;

    // Anexo é conferido antes de tudo: se sumiu do volume, nenhum aluno do
    // lote deve receber só o texto sem perceber que faltou o arquivo.
    const anexo = corpo.anexoId ? anexos.ler(String(corpo.anexoId)) : null;
    if (corpo.anexoId && !anexo) {
      return res.status(410).json({
        erro: 'O arquivo anexado não está mais no servidor (expirou ou o serviço reiniciou). Anexe de novo.',
      });
    }
    const resumoAnexo = anexo ? { id: anexo.id, nome: anexo.nome, tipo: anexo.tipo, tamanho: anexo.tamanho } : null;

    // Destino avulso (um número digitado na mão) continua valendo: às vezes a
    // pessoa ainda não tem ficha.
    const numero = telefone.normalizar(m ? m.telefone : corpo.telefone);
    if (!numero) {
      const motivo = m
        ? `${m.nome} não tem telefone válido cadastrado.`
        : 'Telefone inválido ou ausente.';
      // Falha de cadastro também entra no histórico: é o registro de que a
      // pessoa foi pulada, e não de que ninguém tentou.
      modelos.registrar({
        matriculaId: m ? m.id : null, nome: m ? m.nome : null,
        texto: String(corpo.texto || ''), modeloId: corpo.modeloId || null,
        modeloNome: corpo.modeloNome || null, origem: corpo.origem || 'manual',
        lote: corpo.lote || null, anexo: resumoAnexo, ok: false, motivo,
      });
      return res.status(400).json({ erro: motivo });
    }

    const bruto = String(corpo.texto || '').trim();
    if (!bruto && !anexo) return res.status(400).json({ erro: 'A mensagem está vazia.' });

    // PREENCHER AQUI, E NÃO SÓ NA TELA
    //   O disparo em massa manda o texto já preenchido, mas "Um aluno" com
    //   mensagem escrita na hora não tem prévia: o {{nome}} chegava literal no
    //   WhatsApp do aluno. Este é o único ponto por onde todo envio passa, com
    //   ou sem modelo. Preencher duas vezes é inofensivo — o que já virou nome
    //   não é mais marcador.
    const ficha = m ? destinatarios.porMatricula(m.id) : null;
    const texto = ficha ? destinatarios.preencher(bruto, ficha) : bruto;

    // Sem ficha não há o que preencher: um número avulso não tem nome, treino
    // nem plano. Melhor recusar do que mandar "Olá, {{nome}}!" para alguém.
    const sobrou = texto.match(/\{\{\w+\}\}/g);
    if (sobrou) {
      return res.status(400).json({
        erro: `A mensagem ainda tem ${sobrou.join(', ')} sem preencher. `
          + 'Marcador só funciona com aluno escolhido na lista — em envio para '
          + 'número avulso, escreva o texto já pronto.',
      });
    }

    const r = await enviarTexto(numero, texto, { anexo });

    modelos.registrar({
      matriculaId: m ? m.id : null,
      nome: m ? m.nome : null,
      telefone: numero,
      texto,
      modeloId: corpo.modeloId || null,
      modeloNome: corpo.modeloNome || null,
      origem: corpo.origem || 'manual',
      lote: corpo.lote || null,
      anexo: resumoAnexo,
      ok: r.ok,
      motivo: r.ok ? null : r.motivo,
    });

    if (!r.ok) return res.status(502).json({ erro: r.motivo });
    res.json({ enviado: true, telefone: numero });
  });

  /* ----------------------------- histórico ------------------------------- */

  rotas.get('/historico', (req, res) => {
    res.json({
      historico: modelos.historico({
        limite: req.query.limite,
        lote: req.query.lote || null,
        matriculaId: req.query.matriculaId || null,
      }),
      situacao: modelos.situacao(),
    });
  });

  return rotas;
};
