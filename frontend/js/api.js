/* Organiza+ — GATE FUNC-01: integração básica da API (frontend).
 * Usa somente dados fictícios na homologação; a proteção de senhas no backend
 * original ainda precisará ser fortalecida em outro gate.
 */
(() => {
  'use strict';

  const SESSION_KEY = 'organiza_plus_session';

  function readSession() {
    try {
      const text = sessionStorage.getItem(SESSION_KEY);
      if (!text) return null;
      const session = JSON.parse(text);
      return session && typeof session.token === 'string' ? session : null;
    } catch {
      return null;
    }
  }

  function saveSession(data) {
    if (!data || typeof data.token !== 'string' || !data.user) {
      throw new Error('Resposta de autenticação inválida.');
    }
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      token: data.token,
      user: data.user
    }));
  }

  function clearSession() {
    sessionStorage.removeItem(SESSION_KEY);
  }

  async function request(endpoint, options = {}) {
    const { method = 'GET', body, protectedRoute = false } = options;
    const headers = { Accept: 'application/json' };

    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (protectedRoute) {
      const session = readSession();
      if (!session) throw new Error('Você precisa entrar na sua conta.');
      headers.Authorization = `Bearer ${session.token}`;
    }

    let response;
    try {
      response = await fetch(endpoint, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store'
      });
    } catch {
      throw new Error('Não foi possível conectar ao servidor. Verifique se o Node.js está em execução.');
    }

    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error('O servidor não retornou uma resposta JSON válida.');
    }

    if (!response.ok) {
      if (protectedRoute && response.status === 401) clearSession();
      throw new Error(data.error || `Erro HTTP ${response.status}.`);
    }
    return data;
  }

  function showMessage(element, message, isError = false) {
    if (!element) return;
    element.textContent = message;
    element.style.color = isError ? '#b42318' : '#18794e';
    element.setAttribute('role', 'status');
  }

  async function logout() {
    try {
      if (readSession()) await request('/api/logout', { method: 'POST', protectedRoute: true });
    } catch {
      // Mesmo com sessão expirada, encerra o acesso no navegador.
    } finally {
      clearSession();
      window.location.replace('index.html');
    }
  }

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('click', (event) => {
      const target = event && event.target;
      if (target && typeof target.closest === 'function' && target.closest('[data-logout]')) {
        logout();
      }
    });
  }

  window.OrganizaAPI = Object.freeze({
    request, readSession, saveSession, clearSession, showMessage, logout
  });
  window.logout = logout;
})();
