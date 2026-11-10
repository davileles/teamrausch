/* ════════════════════════════════════════════════════════════════════════════
   nativo.js — ponte entre o sistema do estúdio (index.html) e o app
   Android/iOS do Team Rausch.

   Carregado no <head> do www/index.html pelo montar.mjs, DEPOIS de
   capacitor-plugins.js (core do Capacitor + plugins em build IIFE, que deixa
   os globais capacitorExports, capacitorApp, capacitorBrowser…).

   Fora do app (site app.teamrausch.com.br) este arquivo não é carregado.
   Mesmo assim tudo aqui confere isNativePlatform() antes de agir.

   O que faz:
     1. marca <html class="app-nativo plat-android|plat-ios"> (nativo.css)
     2. abre links externos dentro do app (Browser) e apps de terceiros
        (WhatsApp, Instagram, mapas, e-mail, telefone) fora dele
     3. navigator.share → folha de compartilhar nativa
     4. botão voltar do Android: fecha janela → volta para Agendar → sai
     5. cor dos ícones da barra de status acompanha a tela (cabeçalho preto
        depois de entrar; tema claro/escuro na tela de entrada)
     6. vibração leve ao tocar nas abas
     7. guarda a sessão (agenda-token) também no armazenamento nativo, para
        o sistema não deslogar o aluno ao limpar dados do navegador interno
     7b. entrar com Face ID / digital (chave do celular no cofre do sistema,
        trocada por sessão em /agenda-api/auth/dispositivo/entrar)
     7c. notificações push (só iPhone; APNs direto do servidor do estúdio)
     8. aviso de "sem internet"
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var CAP = window.Capacitor;
  if (!CAP || !CAP.isNativePlatform || !CAP.isNativePlatform()) return;

  var PLATAFORMA = CAP.getPlatform(); // 'android' | 'ios'
  var html = document.documentElement;
  html.classList.add('app-nativo', 'plat-' + PLATAFORMA);
  window.TR_APP = { plataforma: PLATAFORMA, versao: '__VERSAO_APP__' };

  function plugin(global, nome) {
    var mod = window[global];
    return mod && mod[nome] ? mod[nome] : null;
  }
  var App = plugin('capacitorApp', 'App');
  var Browser = plugin('capacitorBrowser', 'Browser');
  var Share = plugin('capacitorShare', 'Share');
  var StatusBar = plugin('capacitorStatusBar', 'StatusBar');
  var SplashScreen = plugin('capacitorSplashScreen', 'SplashScreen');
  var Haptics = plugin('capacitorHaptics', 'Haptics');
  var Preferences = plugin('capacitorPreferences', 'Preferences');
  var Bio = plugin('capacitorCapacitorBiometric', 'NativeBiometric');
  var Push = plugin('capacitorPushNotifications', 'PushNotifications');
  var API = 'https://app.teamrausch.com.br/agenda-api';

  function falhaSilenciosa(p) { if (p && p.catch) p.catch(function () {}); }

  /* ── 2. Links externos ─────────────────────────────────────────────────── */
  // Domínios que têm app próprio: vão para fora (o sistema abre o app certo).
  var HOSTS_APP_EXTERNO = [
    'wa.me', 'api.whatsapp.com', 'chat.whatsapp.com', 'whatsapp.com',
    'instagram.com', 'youtube.com', 'youtu.be',
    'maps.google.com', 'maps.apple.com', 'goo.gl', 'maps.app.goo.gl',
    'apps.apple.com', 'play.google.com', 'wellhub.com', 'gympass.com',
  ];
  function hostCasa(host, lista) {
    host = String(host || '').toLowerCase().replace(/^www\./, '');
    for (var i = 0; i < lista.length; i++) {
      var d = lista[i];
      if (host === d || host.slice(-(d.length + 1)) === '.' + d) return true;
    }
    return false;
  }

  function abrirExterno(url) {
    var u;
    try { u = new URL(url, location.href); } catch (e) { return false; }
    if (u.protocol === 'mailto:' || u.protocol === 'tel:' || u.protocol === 'sms:' || u.protocol === 'whatsapp:') {
      location.href = u.href; // o Capacitor entrega ao sistema
      return true;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (u.host === location.host) return false; // arquivo do próprio app
    if (hostCasa(u.host, HOSTS_APP_EXTERNO) || !Browser) {
      location.href = u.href; // fora do app (Capacitor manda ao sistema)
      return true;
    }
    falhaSilenciosa(Browser.open({ url: u.href, presentationStyle: 'popover', toolbarColor: '#0E0F11' }));
    return true;
  }
  window.trAbrirExterno = abrirExterno;

  document.addEventListener('click', function (ev) {
    if (ev.defaultPrevented || ev.button !== 0) return;
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a || a.hasAttribute('download')) return;
    var href = a.getAttribute('href');
    if (!href || href.charAt(0) === '#' || /^(javascript|blob|data):/i.test(href)) return;
    if (abrirExterno(a.href)) ev.preventDefault();
  }, true);

  // window.open('https://…') → navegador do app. Devolve um objeto parecido
  // com uma janela para o código que testa "if (w)".
  var abrirOriginal = window.open;
  window.open = function (url) {
    if (url && !/^(blob|data):/i.test(String(url)) && abrirExterno(String(url))) {
      return { closed: false, opener: null, close: function () { if (Browser) falhaSilenciosa(Browser.close()); }, focus: function () {} };
    }
    return abrirOriginal.apply(window, arguments);
  };

  /* ── 3. Compartilhar ───────────────────────────────────────────────────── */
  if (Share) {
    navigator.share = function (dados) {
      dados = dados || {};
      return Share.share({
        title: dados.title || undefined,
        text: dados.text || undefined,
        url: dados.url || undefined,
        dialogTitle: 'Compartilhar',
      }).then(function () {});
    };
    navigator.canShare = function () { return true; };
  }

  /* ── 4. Botão voltar (Android) ─────────────────────────────────────────── */
  function visivel(el) {
    if (!el || !el.isConnected) return false;
    var cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getClientRects().length > 0;
  }
  function voltar() {
    // Janela aberta (.fundo-modal): Escape fecha, e clicar no fundo também.
    var janelas = document.querySelectorAll('.fundo-modal');
    var j = janelas.length ? janelas[janelas.length - 1] : null;
    if (j && visivel(j)) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      setTimeout(function () {
        if (visivel(j)) j.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }, 40);
      return;
    }
    var app = document.getElementById('tela-app');
    var ativa = document.querySelector('#abas button[aria-selected="true"]');
    if (app && visivel(app) && ativa && ativa.dataset.aba !== 'agendar' && typeof window.abrirAba === 'function') {
      window.abrirAba('agendar');
      return;
    }
    if (App) falhaSilenciosa(App.minimizeApp());
  }
  if (App && PLATAFORMA === 'android') App.addListener('backButton', voltar);

  /* ── 5. Barra de status ────────────────────────────────────────────────── */
  // Style.Dark = ícones claros (fundo escuro); Style.Light = ícones escuros.
  var estiloAtual = '';
  function ajustarBarra() {
    if (!StatusBar) return;
    var app = document.getElementById('tela-app');
    var logado = app && !app.hidden;
    var escuro = logado || html.getAttribute('data-tema') === 'escuro';
    var estilo = escuro ? 'DARK' : 'LIGHT';
    if (estilo === estiloAtual) return;
    estiloAtual = estilo;
    falhaSilenciosa(StatusBar.setStyle({ style: estilo }));
  }
  new MutationObserver(ajustarBarra).observe(html, { attributes: true, attributeFilter: ['data-tema'] });

  /* ── 6. Vibração leve nas abas ─────────────────────────────────────────── */
  document.addEventListener('click', function (ev) {
    if (!Haptics || !ev.target || !ev.target.closest) return;
    if (ev.target.closest('#abas button')) falhaSilenciosa(Haptics.impact({ style: 'LIGHT' }));
  }, true);

  /* ── 7. Sessão também no armazenamento nativo ──────────────────────────── */
  var CHAVE_SESSAO = 'agenda-token';
  var gravandoPeloApp = false, entrouPorCodigo = false;
  function gravarSessao(token) {
    gravandoPeloApp = true;
    try { localStorage.setItem(CHAVE_SESSAO, token); } catch (e) {}
    gravandoPeloApp = false;
  }
  function tokenAtual() { try { return localStorage.getItem(CHAVE_SESSAO) || ''; } catch (e) { return ''; } }
  var MARCA_SAIU = 'tr_app_sem_restaurar';
  var setOrig = Storage.prototype.setItem, remOrig = Storage.prototype.removeItem;
  if (Preferences) {
    Storage.prototype.setItem = function (k, v) {
      setOrig.apply(this, arguments);
      if (this === window.localStorage && k === CHAVE_SESSAO) {
        falhaSilenciosa(Preferences.set({ key: k, value: String(v) }));
        // Sessão aberta pelo código do WhatsApp (não pelo Face ID nem pela
        // restauração): é a hora de oferecer o Face ID e os avisos.
        if (!gravandoPeloApp) entrouPorCodigo = true;
      }
    };
    Storage.prototype.removeItem = function (k) {
      remOrig.apply(this, arguments);
      if (this === window.localStorage && k === CHAVE_SESSAO) {
        // Saiu (ou a sessão venceu): não restaurar nesta abertura do app.
        try { sessionStorage.setItem(MARCA_SAIU, '1'); } catch (e) {}
        falhaSilenciosa(Preferences.remove({ key: k }));
      }
    };
  }
  // Sessão sumiu do navegador interno mas existe no nativo → devolve e recarrega
  // (uma vez só por abertura do app, para nunca entrar em ciclo). Se ela já
  // venceu no servidor, o próprio sistema pede para entrar de novo.
  function restaurarSessaoNativa() {
    if (!Preferences) return;
    var atual = null, podeRestaurar = true;
    try { atual = localStorage.getItem(CHAVE_SESSAO); } catch (e) {}
    try { podeRestaurar = !sessionStorage.getItem(MARCA_SAIU); } catch (e) {}
    Preferences.get({ key: CHAVE_SESSAO }).then(function (r) {
      var salvo = r && r.value;
      if (!atual && salvo && podeRestaurar) {
        try { sessionStorage.setItem(MARCA_SAIU, '1'); } catch (e) {}
        try { setOrig.call(localStorage, CHAVE_SESSAO, salvo); location.reload(); } catch (e) {}
        return;
      } else if (atual && atual !== salvo) {
        falhaSilenciosa(Preferences.set({ key: CHAVE_SESSAO, value: atual }));
      }
    }).catch(function () {});
  }


  /* ── 7b. Entrar com Face ID / digital ──────────────────────────────────── */
  // 1º acesso: código no WhatsApp. Logo depois o app oferece a biometria; se o
  // aluno aceita, o servidor entrega uma chave deste celular (vale 180 dias e
  // se renova com o uso) que fica no cofre do sistema, só liberada pelo Face
  // ID/digital. Nas próximas aberturas a chave vira uma sessão nova. Voltar ao
  // app depois de 30 min em segundo plano pede a biometria de novo.
  var BIO_SERVIDOR = 'app.teamrausch.com.br';
  var BIO_PREF = 'tr_bio';
  var bioInfo = null;      // { id } quando ativado neste celular
  var bioNome = 'Face ID'; // rótulo pelo tipo de biometria do aparelho
  var bioDisp = false;

  function post(caminho, corpo, comSessao) {
    var cab = { 'Content-Type': 'application/json' };
    var t = tokenAtual();
    if (comSessao && t) cab.Authorization = 'Bearer ' + t;
    return fetch(API + caminho, { method: 'POST', headers: cab, body: JSON.stringify(corpo || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j._status = r.status; return j; }); });
  }
  function nomeBiometria(t) {
    if (t === 2) return 'Face ID';
    if (t === 1) return 'Touch ID';
    if (t === 3) return 'digital';
    if (t === 4) return 'reconhecimento facial';
    return 'biometria';
  }
  function bioDisponivel() {
    if (!Bio) return Promise.resolve(false);
    return Bio.isAvailable({ useFallback: false }).then(function (r) {
      if (r && r.isAvailable) bioNome = nomeBiometria(r.biometryType);
      return !!(r && r.isAvailable);
    }).catch(function () { return false; });
  }
  function bioEsquecer() {
    bioInfo = null;
    if (Preferences) falhaSilenciosa(Preferences.remove({ key: BIO_PREF }));
    if (Bio) falhaSilenciosa(Bio.deleteCredentials({ server: BIO_SERVIDOR }));
    var b = document.getElementById('tr-bio-login'); if (b) b.remove();
  }

  function el(tag, attrs, filhos) {
    var e = document.createElement(tag);
    for (var k in (attrs || {})) {
      if (k === 'onclick') e.addEventListener('click', attrs[k]);
      else if (k === 'text') e.textContent = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    (filhos || []).forEach(function (f) { if (f) e.appendChild(f); });
    return e;
  }
  function aviso(texto) {
    var t = el('div', { 'class': 'tr-toast', role: 'status', text: texto });
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('on'); }, 10);
    setTimeout(function () { t.classList.remove('on'); setTimeout(function () { t.remove(); }, 300); }, 3200);
  }
  function telaAppVisivel() { var a = document.getElementById('tela-app'); return !!(a && !a.hidden); }
  function voltarParaLogin() {
    if (typeof window.sair === 'function') falhaSilenciosa(window.sair(true));
    else try { localStorage.removeItem(CHAVE_SESSAO); } catch (e) {}
  }

  // Tela de desbloqueio por cima de tudo.
  var trava = null;
  function mostrarTrava(automatico) {
    if (!bioInfo) return;
    if (!trava) {
      var msg = el('div', { 'class': 'tr-bio-msg', text: '' });
      trava = el('div', { id: 'tr-bio-trava', role: 'dialog', 'aria-label': 'Desbloquear' }, [
        el('div', { 'class': 'tr-bio-caixa' }, [
          el('img', { src: 'logo.png', alt: '', 'class': 'tr-bio-logo' }),
          el('div', { 'class': 'tr-bio-titulo', text: 'Team Rausch' }),
          el('div', { 'class': 'tr-bio-sub', text: 'Seus horários no estúdio' }),
          el('button', { 'class': 'tr-bio-btn', type: 'button', onclick: function () { desbloquear(); } }, [
            el('span', { 'class': 'tr-bio-btn-txt', text: 'Entrar com ' + bioNome }),
          ]),
          msg,
          el('button', { 'class': 'tr-bio-link', type: 'button', text: 'Entrar com o telefone', onclick: function () {
            esconderTrava();
            voltarParaLogin();
          } }),
        ]),
      ]);
      trava._msg = msg;
      document.body.appendChild(trava);
    }
    trava.querySelector('.tr-bio-btn-txt').textContent = 'Entrar com ' + bioNome;
    trava._msg.textContent = '';
    trava.style.display = 'flex';
    if (automatico) setTimeout(desbloquear, 250);
  }
  function esconderTrava() { if (trava) trava.style.display = 'none'; }

  var desbloqueando = false;
  function desbloquear() {
    if (desbloqueando || !bioInfo || !Bio) return;
    desbloqueando = true;
    var msg = trava && trava._msg;
    if (msg) msg.textContent = '';
    Bio.getSecureCredentials({
      server: BIO_SERVIDOR,
      reason: 'Entrar no Team Rausch',
      title: 'Entrar no Team Rausch',
      negativeButtonText: 'Cancelar',
    }).then(function (cred) {
      if (msg) msg.textContent = 'Entrando…';
      return post('/auth/dispositivo/entrar', { id: cred.username, segredo: cred.password });
    }).then(function (r) {
      desbloqueando = false;
      if (r && r.ok && r.token) {
        gravarSessao(r.token);
        esconderTrava();
        // Sem a tela do app à vista (estava no login): carrega a conta agora.
        if (!telaAppVisivel() && typeof window.comecar === 'function') falhaSilenciosa(window.comecar(false, true));
        setTimeout(iniciarPush, 800);
        return;
      }
      var motivo = r && r.motivo;
      if (motivo === 'chave' || motivo === 'expirada' || motivo === 'bloqueado') {
        bioEsquecer();
        esconderTrava();
        voltarParaLogin();
        alert(motivo === 'bloqueado'
          ? 'Seu acesso está suspenso. Fale com o estúdio.'
          : 'O acesso por ' + bioNome + ' venceu neste celular. Entre com o telefone e ative de novo.');
        return;
      }
      if (msg) msg.textContent = 'Não foi possível entrar agora. Confira a internet e toque de novo.';
    }).catch(function (e) {
      desbloqueando = false;
      var cod = e && (e.code || e.errorCode);
      // 21 = credencial sumiu (biometria do aparelho mudou ou app reinstalado)
      if (String(cod) === '21' || /No protected credentials|not found|invalidated/i.test(String(e && e.message))) {
        bioEsquecer();
        esconderTrava();
        if (!telaAppVisivel()) voltarParaLogin();
        alert('O ' + bioNome + ' foi alterado neste celular. Entre com o telefone e ative de novo.');
        return;
      }
      if (msg) msg.textContent = 'Toque no botão para tentar de novo.';
    });
  }

  function oferecerBiometria() {
    if (bioInfo || !tokenAtual() || document.getElementById('tr-convite')) return;
    var fundo;
    function fechar() { if (fundo) fundo.remove(); setTimeout(iniciarPush, 600); }
    function ativar(btn) {
      btn.disabled = true;
      btn.textContent = 'Ativando…';
      post('/auth/dispositivo', { plataforma: PLATAFORMA }, true)
        .then(function (r) {
          if (!r || !r.ok || !r.id || !r.segredo) throw new Error((r && r.erro) || 'falha');
          return Bio.setCredentials({
            username: r.id, password: r.segredo, server: BIO_SERVIDOR,
            accessControl: 2, // BIOMETRY_ANY: sobrevive a cadastrar outro dedo/rosto
            title: 'Confirme para ativar o ' + bioNome, negativeButtonText: 'Cancelar',
          }).then(function () { return r; });
        })
        .then(function (r) {
          bioInfo = { id: r.id };
          if (Preferences) falhaSilenciosa(Preferences.set({ key: BIO_PREF, value: JSON.stringify(bioInfo) }));
          fechar();
          aviso(bioNome + ' ativado. Na próxima vez é só olhar ou tocar.');
        })
        .catch(function () {
          btn.disabled = false;
          btn.textContent = 'Tentar de novo';
        });
    }
    var btnSim = el('button', { 'class': 'tr-bio-btn', type: 'button', text: 'Ativar ' + bioNome });
    btnSim.addEventListener('click', function () { ativar(btnSim); });
    fundo = el('div', { id: 'tr-convite' }, [
      el('div', { 'class': 'tr-bio-caixa' }, [
        el('div', { 'class': 'tr-bio-titulo', text: 'Entrar com ' + bioNome + '?' }),
        el('div', { 'class': 'tr-bio-sub', text: 'Nas próximas vezes você entra sem esperar o código no WhatsApp.' }),
        btnSim,
        el('button', { 'class': 'tr-bio-link', type: 'button', text: 'Agora não', onclick: fechar }),
      ]),
    ]);
    document.body.appendChild(fundo);
  }

  // Na tela de entrada (depois de "Sair"): botão para voltar com a biometria.
  function botaoNoLogin() {
    var passo = document.getElementById('passo-telefone');
    if (!passo || !bioInfo || document.getElementById('tr-bio-login')) return;
    var bloco = el('div', { id: 'tr-bio-login' }, [
      el('button', { 'class': 'tr-bio-btn', type: 'button', text: 'Entrar com ' + bioNome, onclick: function () { mostrarTrava(true); } }),
      el('button', { 'class': 'tr-bio-link', type: 'button', text: 'Desativar ' + bioNome + ' neste celular', onclick: function () {
        if (!confirm('Desativar a entrada por ' + bioNome + ' neste celular?')) return;
        var id = bioInfo && bioInfo.id;
        bioEsquecer();
        if (id && tokenAtual()) falhaSilenciosa(post('/auth/dispositivo/remover', { id: id }, true));
      } }),
      el('div', { 'class': 'tr-bio-ou', text: 'ou entre com o telefone' }),
    ]);
    passo.insertBefore(bloco, passo.firstChild);
  }

  var emSegundoPlanoDesde = 0;
  if (App) App.addListener('appStateChange', function (st) {
    if (!st.isActive) { emSegundoPlanoDesde = Date.now(); return; }
    if (bioInfo && tokenAtual() && emSegundoPlanoDesde && Date.now() - emSegundoPlanoDesde > 30 * 60 * 1000) mostrarTrava(true);
    emSegundoPlanoDesde = 0;
  });

  function iniciarBiometria() {
    var saiu = false;
    try { saiu = !!sessionStorage.getItem(MARCA_SAIU); } catch (e) {}
    var lerPref = Preferences ? Preferences.get({ key: BIO_PREF }) : Promise.resolve(null);
    Promise.all([lerPref.catch(function () { return null; }), bioDisponivel()]).then(function (res) {
      var pref = res[0] && res[0].value;
      bioDisp = res[1];
      try { bioInfo = pref ? JSON.parse(pref) : null; } catch (e) { bioInfo = null; }
      if (bioInfo && !bioDisp) bioInfo = null; // biometria desligada no aparelho: só telefone
      if (!bioInfo) { restaurarSessaoNativa(); return; }
      if (saiu) { botaoNoLogin(); return; }
      // Com biometria a sessão é renovada pelo Face ID: não restaura a antiga.
      mostrarTrava(true);
    });
  }

  // Entrou pelo código: oferece o Face ID (uma vez por login) e depois os avisos.
  function depoisDoLogin() {
    if (!entrouPorCodigo || !telaAppVisivel()) return;
    entrouPorCodigo = false;
    if (bioDisp && !bioInfo) setTimeout(oferecerBiometria, 700);
    else setTimeout(iniciarPush, 1200);
  }

  /* ── 7c. Notificações push ─────────────────────────────────────────────── */
  // Só iPhone por enquanto (APNs direto do servidor do estúdio). No Android o
  // push depende do Firebase, que não está configurado: não registra lá.
  // Permissão: pedida uma vez depois do login, com explicação antes do pedido
  // do sistema; se já liberada, registra a cada abertura (o token pode mudar).
  var PUSH_ATIVO = !!Push && PLATAFORMA === 'ios';
  var pushTokenEnviado = '';
  function enviarTokenPush(token) {
    var sessao = tokenAtual();
    if (!token || !sessao) return;
    var chave = token + '|' + sessao;
    if (pushTokenEnviado === chave) return;
    post('/auth/dispositivo/push', { id: bioInfo ? bioInfo.id : '', plataforma: PLATAFORMA, pushToken: token }, true)
      .then(function (r) { if (r && r.ok) pushTokenEnviado = chave; })
      .catch(function () {});
  }
  function registrarPush() {
    if (!PUSH_ATIVO) return Promise.resolve(false);
    return Push.register().then(function () { return true; }).catch(function () { return false; });
  }
  function pedirPush() {
    if (!PUSH_ATIVO || !tokenAtual()) return Promise.resolve(false);
    return Push.checkPermissions().then(function (st) {
      if (st.receive === 'granted') return registrarPush();
      if (st.receive === 'denied') return false;
      return Push.requestPermissions().then(function (r) {
        return r.receive === 'granted' ? registrarPush() : false;
      });
    }).catch(function () { return false; });
  }
  window.trPushPedir = pedirPush;
  if (PUSH_ATIVO) {
    Push.addListener('registration', function (t) { enviarTokenPush(t && t.value); });
    Push.addListener('registrationError', function () {});
    // Toque na notificação: abre a aba indicada (agendar, meus, perfil…).
    Push.addListener('pushNotificationActionPerformed', function (ev) {
      var d = (ev && ev.notification && ev.notification.data) || {};
      if (!d.aba) return;
      var tentativas = 0;
      (function abrir() {
        if (telaAppVisivel() && typeof window.abrirAba === 'function') { window.abrirAba(d.aba); return; }
        if (++tentativas < 20) setTimeout(abrir, 500);
      })();
    });
    // Com o app aberto o sistema não mostra o banner: mostra um aviso na tela.
    Push.addListener('pushNotificationReceived', function (n) {
      if (n && (n.title || n.body) && document.body) aviso((n.title || '') + (n.body ? ' — ' + n.body : ''));
    });
  }
  function iniciarPush() {
    if (!PUSH_ATIVO || !tokenAtual()) return;
    Push.checkPermissions().then(function (st) {
      if (st.receive === 'granted') { registrarPush(); return; }
      if (st.receive === 'denied' || !Preferences) return;
      Preferences.get({ key: 'tr_push_perguntado' }).then(function (r) {
        if (r && r.value) return;
        Preferences.set({ key: 'tr_push_perguntado', value: '1' });
        setTimeout(convitePush, 1200);
      }).catch(function () {});
    }).catch(function () {});
  }
  function convitePush() {
    if (document.getElementById('tr-convite')) { setTimeout(convitePush, 4000); return; }
    var fundo;
    function fechar() { if (fundo) fundo.remove(); }
    fundo = el('div', { id: 'tr-convite' }, [
      el('div', { 'class': 'tr-bio-caixa' }, [
        el('div', { 'class': 'tr-bio-titulo', text: 'Receber avisos do estúdio?' }),
        el('div', { 'class': 'tr-bio-sub', text: 'Lembretes de aula, avisos do estúdio e suas conquistas chegam direto no celular.' }),
        el('button', { 'class': 'tr-bio-btn', type: 'button', text: 'Ativar avisos', onclick: function () { fechar(); pedirPush(); } }),
        el('button', { 'class': 'tr-bio-link', type: 'button', text: 'Agora não', onclick: fechar }),
      ]),
    ]);
    document.body.appendChild(fundo);
  }

  /* ── 8. Sem internet ───────────────────────────────────────────────────── */
  function avisoRede() {
    var el = document.getElementById('tr-offline');
    if (!el) {
      if (!document.body) return;
      el = document.createElement('div');
      el.id = 'tr-offline';
      el.setAttribute('role', 'status');
      el.textContent = 'Sem internet. Assim que voltar, o app atualiza sozinho.';
      document.body.appendChild(el);
    }
    el.classList.toggle('on', !navigator.onLine);
  }
  window.addEventListener('online', avisoRede);
  window.addEventListener('offline', avisoRede);

  // Voltou para o app depois de um tempo fora: recarrega os horários (vagas
  // mudam enquanto o app está em segundo plano).
  var saiuEm = 0;
  if (App) {
    App.addListener('appStateChange', function (st) {
      if (!st.isActive) { saiuEm = Date.now(); return; }
      if (saiuEm && Date.now() - saiuEm > 10 * 60 * 1000 && navigator.onLine) {
        var app = document.getElementById('tela-app');
        if (app && !app.hidden && typeof window.abrirAba === 'function') {
          var ativa = document.querySelector('#abas button[aria-selected="true"]');
          window.abrirAba(ativa ? ativa.dataset.aba : 'agendar');
        }
      }
      saiuEm = 0;
    });
  }

  /* ── Ao terminar de carregar ───────────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', function () {
    iniciarBiometria();
    ajustarBarra();
    // Entrar/sair troca o atributo hidden de #tela-login/#tela-app.
    ['tela-app', 'tela-login'].forEach(function (id) {
      var alvo = document.getElementById(id);
      if (alvo) new MutationObserver(function () {
        ajustarBarra();
        depoisDoLogin();
        // Saiu da conta: a tela de entrada ganha o botão do Face ID.
        if (bioInfo && !telaAppVisivel()) botaoNoLogin();
      }).observe(alvo, { attributes: true, attributeFilter: ['hidden'] });
    });
    // Já logado de outra abertura (sessão válida, sem Face ID): confere os avisos.
    setTimeout(function () { if (!bioInfo && telaAppVisivel()) iniciarPush(); }, 2500);
    if (!navigator.onLine) avisoRede();
    if (SplashScreen) setTimeout(function () { falhaSilenciosa(SplashScreen.hide()); }, 150);
  });
})();
