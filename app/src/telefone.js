'use strict';

/**
 * app/src/telefone.js — davileles/teamrausch
 *
 * Telefone em E.164 ('5531988887777'), que é a chave primária do cadastro de
 * login. Ficou num módulo próprio quando a gestão de acesso saiu da aba Alunos
 * e foi para dentro da matrícula: os dois lados precisam concordar sobre o que
 * é o mesmo número, senão trocar o telefone na ficha criaria um cadastro novo
 * em vez de mover o existente.
 */

/** Aceita '(31) 98888-7777', '31988887777', '5531988887777'. Devolve E.164 ou null. */
function normalizar(entrada) {
  let n = String(entrada || '').replace(/\D/g, '');
  if (n.startsWith('55') && n.length >= 12) n = n.slice(2);
  if (n.length === 10) {
    // fixo ou celular antigo: completa o nono dígito quando for celular
    if (['6', '7', '8', '9'].includes(n[2])) n = n.slice(0, 2) + '9' + n.slice(2);
  }
  if (n.length !== 11) return null;
  const ddd = Number(n.slice(0, 2));
  if (ddd < 11 || ddd > 99) return null;
  if (n[2] !== '9') return null;
  return '55' + n;
}

function mostrar(e164) {
  if (!e164) return null;
  const n = String(e164).replace(/^55/, '');
  if (n.length !== 11) return String(e164);
  return `(${n.slice(0, 2)}) ${n.slice(2, 7)}-${n.slice(7)}`;
}

module.exports = { normalizar, mostrar };
