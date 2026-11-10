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
  var MARCA_SAIU = 'tr_app_sem_restaurar';
  var setOrig = Storage.prototype.setItem, remOrig = Storage.prototype.removeItem;
  if (Preferences) {
    Storage.prototype.setItem = function (k, v) {
      setOrig.apply(this, arguments);
      if (this === window.localStorage && k === CHAVE_SESSAO) falhaSilenciosa(Preferences.set({ key: k, value: String(v) }));
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
      } else if (atual && atual !== salvo) {
        falhaSilenciosa(Preferences.set({ key: CHAVE_SESSAO, value: atual }));
      }
    }).catch(function () {});
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
    restaurarSessaoNativa();
    ajustarBarra();
    // Entrar/sair troca o atributo hidden de #tela-login/#tela-app.
    ['tela-app', 'tela-login'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) new MutationObserver(ajustarBarra).observe(el, { attributes: true, attributeFilter: ['hidden'] });
    });
    if (!navigator.onLine) avisoRede();
    if (SplashScreen) setTimeout(function () { falhaSilenciosa(SplashScreen.hide()); }, 150);
  });
})();
