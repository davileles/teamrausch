'use strict';

const fs = require('fs');
const path = require('path');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ARQUIVO = path.join(DIR, 'wellhub.json');
const RETER_DIAS = Number(process.env.RETER_DIAS || 90);

let dados = { checkins: [], alunos: {} };
let gravacaoPendente = null;

function carregar() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    if (fs.existsSync(ARQUIVO)) {
      dados = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
      dados.checkins ||= [];
      dados.alunos ||= {};
    }
  } catch (erro) {
    console.error('[store] não consegui ler o arquivo, começando vazio:', erro.message);
  }
}

function gravar() {
  if (gravacaoPendente) return;
  gravacaoPendente = setTimeout(() => {
    gravacaoPendente = null;
    try {
      fs.mkdirSync(DIR, { recursive: true });
      const temp = `${ARQUIVO}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(dados, null, 2));
      fs.renameSync(temp, ARQUIVO);
    } catch (erro) {
      console.error('[store] falha ao gravar:', erro.message);
    }
  }, 300);
}

function limpar() {
  const corte = Date.now() - RETER_DIAS * 86400000;
  const antes = dados.checkins.length;
  dados.checkins = dados.checkins.filter((c) => new Date(c.criadoEm).getTime() > corte);
  if (dados.checkins.length !== antes) gravar();
}

function situacao(c) {
  if (c.status === 'validado') return 'validado';
  if (c.status === 'recusado') return 'recusado';
  return new Date(c.validoAte).getTime() < Date.now() ? 'expirado' : 'aguardando';
}

function comSituacao(c) {
  return { ...c, situacao: situacao(c), payloadOriginal: undefined };
}

function salvarCheckin(checkin) {
  const existente = dados.checkins.find(
    (c) => c.gympassId === checkin.gympassId && c.validoAte === checkin.validoAte
  );
  if (existente) return existente;

  const registro = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ...checkin,
    status: 'aguardando',
    validadoEm: null,
    origem: null,
    motivo: null,
  };
  dados.checkins.unshift(registro);

  const aluno = dados.alunos[checkin.gympassId] || { gympassId: checkin.gympassId, visitas: 0 };
  aluno.nome = checkin.nome || aluno.nome || null;
  aluno.sobrenome = checkin.sobrenome || aluno.sobrenome || null;
  aluno.email = checkin.email || aluno.email || null;
  aluno.primeiraVisita ||= checkin.criadoEm;
  aluno.ultimaVisita = checkin.criadoEm;
  aluno.visitas += 1;
  dados.alunos[checkin.gympassId] = aluno;

  limpar();
  gravar();
  return registro;
}

function listarCheckins({ situacao: filtro, busca, limite = 100 } = {}) {
  let lista = dados.checkins.map(comSituacao);
  if (filtro && filtro !== 'todos') lista = lista.filter((c) => c.situacao === filtro);
  if (busca) {
    const q = String(busca).toLowerCase();
    lista = lista.filter(
      (c) => c.gympassId.toLowerCase().includes(q) ||
             `${c.nome || ''} ${c.sobrenome || ''}`.toLowerCase().includes(q)
    );
  }
  return lista.slice(0, limite);
}

/** Check-in ativo mais recente de um aluno (o que a catraca precisa). */
function checkinAtivo(gympassId) {
  return dados.checkins.find(
    (c) => c.gympassId === gympassId && situacao(c) === 'aguardando'
  ) || null;
}

function marcar(id, status, { origem, motivo } = {}) {
  const c = dados.checkins.find((x) => x.id === id);
  if (!c) return null;
  c.status = status;
  c.motivo = motivo || null;
  c.origem = origem || null;
  if (status === 'validado') c.validadoEm = new Date().toISOString();
  gravar();
  return comSituacao(c);
}

function alunoPorCodigo(codigo) {
  const alvo = String(codigo).trim().toLowerCase();
  return Object.values(dados.alunos).find(
    (a) => a.codigo && String(a.codigo).toLowerCase() === alvo
  ) || null;
}

function definirCodigo(gympassId, codigo) {
  const aluno = dados.alunos[gympassId] || { gympassId, visitas: 0 };
  aluno.codigo = codigo || null;
  dados.alunos[gympassId] = aluno;
  gravar();
  return aluno;
}

function listarAlunos() {
  return Object.values(dados.alunos).sort(
    (a, b) => new Date(b.ultimaVisita || 0) - new Date(a.ultimaVisita || 0)
  );
}

function resumo() {
  const hoje = new Date().toISOString().slice(0, 10);
  const doDia = dados.checkins.filter((c) => c.criadoEm.slice(0, 10) === hoje);
  return {
    hoje: doDia.length,
    validadosHoje: doDia.filter((c) => c.status === 'validado').length,
    aguardando: dados.checkins.filter((c) => situacao(c) === 'aguardando').length,
    expiradosHoje: doDia.filter((c) => situacao(c) === 'expirado').length,
    alunos: Object.keys(dados.alunos).length,
  };
}

carregar();

module.exports = {
  salvarCheckin, listarCheckins, checkinAtivo, marcar,
  alunoPorCodigo, definirCodigo, listarAlunos, resumo, situacao,
};
