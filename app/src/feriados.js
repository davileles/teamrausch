'use strict';

/**
 * FERIADOS NACIONAIS E DE BELO HORIZONTE
 *
 * Dia de feriado não conta: não anda a régua de ritmo do Wellhub, não vira
 * aula prevista (nem falta) de quem tem grade fixa, não derruba sequência nos
 * rankings da TV e não entra na retenção. Calculado aqui, sem serviço externo
 * e sem precisar cadastrar ano a ano em Configurações → datas bloqueadas
 * (que continuam valendo para os dias em que o estúdio fecha por outro motivo).
 *
 * Nacionais (Lei 662/1949, 6.802/1980, 14.759/2023): 1º/jan, Sexta-feira
 * Santa, 21/abr, 1º/mai, 7/set, 12/out, 2/nov, 15/nov, 20/nov, 25/dez.
 * Municipais de Belo Horizonte: Corpus Christi, 15/ago (Assunção de Nossa
 * Senhora) e 8/dez (Imaculada Conceição).
 * Carnaval e Quarta-feira de Cinzas são ponto facultativo, não feriado — se o
 * estúdio fechar, entram em datas bloqueadas.
 */

const config = require('./config');

const FIXOS = {
  '01-01': 'Confraternização Universal',
  '04-21': 'Tiradentes',
  '05-01': 'Dia do Trabalho',
  '08-15': 'Assunção de Nossa Senhora (BH)',
  '09-07': 'Independência do Brasil',
  '10-12': 'Nossa Senhora Aparecida',
  '11-02': 'Finados',
  '11-15': 'Proclamação da República',
  '11-20': 'Dia da Consciência Negra',
  '12-08': 'Imaculada Conceição (BH)',
  '12-25': 'Natal',
};

const cache = new Map();

/** Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher), como 'AAAA-MM-DD'. */
function pascoa(ano) {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

function somar(data, dias) {
  const d = new Date(`${data}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/** Mapa 'AAAA-MM-DD' → nome do feriado, para um ano. */
function doAno(ano) {
  ano = Number(ano);
  if (cache.has(ano)) return cache.get(ano);
  const mapa = new Map();
  for (const [md, nome] of Object.entries(FIXOS)) {
    if (md === '11-20' && ano < 2024) continue;   // nacional desde a Lei 14.759/2023
    mapa.set(`${ano}-${md}`, nome);
  }
  const p = pascoa(ano);
  mapa.set(somar(p, -2), 'Sexta-feira Santa');
  mapa.set(somar(p, 60), 'Corpus Christi (BH)');
  cache.set(ano, mapa);
  return mapa;
}

/** Nome do feriado na data, ou null. */
function feriado(data) {
  const s = String(data || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return doAno(s.slice(0, 4)).get(s) || null;
}

function ehFeriado(data) { return feriado(data) !== null; }

function bloqueadas() {
  try { return new Set((config.ler().agenda || {}).datasBloqueadas || []); }
  catch (_) { return new Set(); }
}

/**
 * Dia que não conta: feriado (nacional ou de BH) ou data bloqueada na agenda.
 * Para checar muitas datas, use `verificador()` (lê a configuração uma vez).
 */
function naoConta(data) { return verificador()(data); }

function verificador() {
  const b = bloqueadas();
  return (data) => b.has(data) || ehFeriado(data);
}

/** Lista de feriados entre duas datas (inclusive): [{ data, nome }]. */
function entre(de, ate) {
  const out = [];
  for (let ano = Number(String(de).slice(0, 4)); ano <= Number(String(ate).slice(0, 4)); ano++) {
    for (const [data, nome] of doAno(ano)) if (data >= de && data <= ate) out.push({ data, nome });
  }
  return out.sort((a, b) => a.data.localeCompare(b.data));
}

module.exports = { feriado, ehFeriado, naoConta, verificador, entre, pascoa };
