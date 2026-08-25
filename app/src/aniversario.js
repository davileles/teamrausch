'use strict';

/**
 * app/src/aniversario.js — davileles/teamrausch
 *
 * Dia e mês de nascimento, no formato 'MM-DD'. Sem ano: o estúdio quer saber
 * quando parabenizar, não a idade de ninguém — e menos dado guardado é menos
 * dado a proteger.
 *
 * Vive num módulo próprio porque agora dois cadastros usam o campo: a ficha de
 * login (`agenda-store`, chave por telefone) e a matrícula (`matriculas-store`,
 * chave por id). Duas cópias da mesma validação acabariam divergindo, e um
 * '31/02' aceito num lado e recusado no outro é o tipo de bug que só aparece
 * quando o aluno reclama que a data sumiu.
 */

const DIAS_NO_MES = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Aceita '07/03', '7/3', '03-07' (dia-mês) ou já no formato 'MM-DD'. */
function normalizar(entrada) {
  const texto = String(entrada || '').trim();
  if (!texto) return null;

  const partes = texto.split(/[\/\-.]/).map((p) => p.trim());
  if (partes.length !== 2 || partes.some((p) => !/^\d{1,2}$/.test(p))) return null;

  // 'MM-DD' vem do próprio banco; o resto vem do usuário como dia/mês.
  const ehCanonico = /^\d{2}-\d{2}$/.test(texto);
  const dia = Number(ehCanonico ? partes[1] : partes[0]);
  const mes = Number(ehCanonico ? partes[0] : partes[1]);

  if (mes < 1 || mes > 12) return null;
  if (dia < 1 || dia > DIAS_NO_MES[mes - 1]) return null;
  return `${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

/** 'MM-DD' → '07/03', para mostrar na tela. */
function mostrar(mmdd) {
  if (!mmdd) return null;
  const [m, d] = String(mmdd).split('-');
  return `${d}/${m}`;
}

module.exports = { normalizar, mostrar };
