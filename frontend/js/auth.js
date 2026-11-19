/* Organiza+ — GATE FUNC-01: formulários de cadastro e login. */
(() => {
  'use strict';
  const api = window.OrganizaAPI;
  const registerForm = document.getElementById('registerForm');
  const loginForm = document.getElementById('loginForm');
  const messageElement = document.getElementById('message');

  if (!api) {
    if (messageElement) messageElement.textContent = 'Erro ao carregar o módulo de comunicação com o servidor.';
    return;
  }

  function setBusy(form, busy) {
    const submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = busy;
  }

  if (registerForm) {
    registerForm.addEventListener('submit', async (event) => {
      event.preventDefault(); // Impede o envio de senhas na URL via GET.
      const data = new FormData(registerForm);
      const name = String(data.get('name') || '').trim();
      const email = String(data.get('email') || '').trim();
      const password = String(data.get('password') || '');

      if (!name || name.length > 120 || !email || email.length > 254 || password.length < 15 || password.length > 128) {
        api.showMessage(messageElement, 'Informe nome, e-mail válido e senha entre 15 e 128 caracteres.', true);
        return;
      }

      setBusy(registerForm, true);
      api.showMessage(messageElement, 'Cadastrando…');
      try {
        const result = await api.request('/api/register', {
          method: 'POST', body: { name, email, password }
        });
        registerForm.reset();
        api.showMessage(messageElement, `${result.message || 'Cadastro realizado.'} Acesse a página de login.`);
      } catch (error) {
        api.showMessage(messageElement, error.message, true);
      } finally {
        setBusy(registerForm, false);
      }
    });
  }

  if (loginForm) {
    loginForm.addEventListener('submit', async (event) => {
      event.preventDefault(); // Evita que a senha vá para a barra de endereço.
      const data = new FormData(loginForm);
      const email = String(data.get('email') || '').trim();
      const password = String(data.get('password') || '');
      if (!email || email.length > 254 || !password || password.length > 128) {
        api.showMessage(messageElement, 'Informe e-mail e senha válidos.', true);
        return;
      }

      setBusy(loginForm, true);
      api.showMessage(messageElement, 'Entrando…');
      try {
        const result = await api.request('/api/login', {
          method: 'POST', body: { email, password }
        });
        api.saveSession(result);
        window.location.replace('dashboard.html');
      } catch (error) {
        api.showMessage(messageElement, error.message, true);
      } finally {
        setBusy(loginForm, false);
      }
    });
  }
})();
