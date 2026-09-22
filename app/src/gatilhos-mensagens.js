'use strict';

/**
 * app/src/gatilhos-mensagens.js — davileles/teamrausch
 *
 * Dispara conquistas e meta do mês NA HORA em que a aula entra no sistema,
 * em vez de esperar a passada da noite.
 *
 * QUEM CHAMA
 *   - poller-portal.js, quando o ciclo grava check-in novo do Wellhub;
 *   - rotas-totem.js, quando o tablet grava presença nova (normal ou liberada).
 *
 * A CONTA NÃO É FEITA AQUI
 *   Só chamamos o `rodar()` de cada módulo — o mesmo da passada noturna. Quem
 *   decide quem bateu o quê, e quem já foi avisado, continua sendo cada um
 *   deles. Por isso ninguém recebe duas vezes: o estado anotado vale para as
 *   duas portas de entrada.
 *
 * ESPERA CURTA ANTES DE RODAR
 *   Um ciclo do poller pode trazer vários check-ins, e duas pessoas podem
 *   passar no totem no mesmo minuto. A espera junta tudo numa passada só.
 *
 * A PASSADA DA NOITE CONTINUA
 *   Rodamos com `marcarDia: false`, então a passada noturna ainda acontece e
 *   pega o que falhou aqui (WhatsApp fora do ar, cadastro sem telefone
 *   corrigido depois, vínculo de check-in feito à mão).
 */

const ESPERA_MS = Math.max(5, Number(process.env.GATILHO_ESPERA_SEGUNDOS || 90)) * 1000;

let timer = null;

function log(...a) { console.log(new Date().toISOString(), '[gatilhos]', ...a); }

async function rodarTudo(origens) {
  // Carregados aqui, não no topo: poller-portal e os módulos de mensagem se
  // exigem mutuamente, e o require tardio evita o ciclo na subida.
  const modulos = [
    ['conquistas', require('./conquistas-mensagens')],
    ['meta-mensal', require('./meta-mensal-mensagens')],
  ];
  for (const [nome, mod] of modulos) {
    try {
      if (!mod.situacao().ativo) continue;
      const r = await mod.rodar({ marcarDia: false });
      if (r && (r.enviados || r.falhas)) {
        log(`${nome}: ${r.enviados || 0} enviada(s), ${r.falhas || 0} falha(s) — origem ${origens}.`);
      }
    } catch (e) {
      log(`${nome} falhou:`, e.message);
    }
  }
}

/**
 * Avisa que entrou aula nova. Chamadas próximas viram uma passada só.
 * @param {string} origem  'wellhub' | 'totem' | 'totem-liberado'
 */
function aulaNova(origem = 'desconhecida') {
  if (timer) { timer.origens.add(origem); return; }
  const origens = new Set([origem]);
  timer = setTimeout(() => {
    timer = null;
    rodarTudo([...origens].join('+')).catch((e) => log('falhou:', e.message));
  }, ESPERA_MS);
  timer.origens = origens;
  timer.unref?.();
}

module.exports = { aulaNova };
