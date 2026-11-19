/* Organiza+ - Recuperacao do modulo Disciplinas */
(() => {
  'use strict';

  const api = window.OrganizaAPI;

  if (!api || !api.readSession()) {
    window.location.replace('index.html');
    return;
  }

  const form = document.getElementById('disciplineForm');
  const list = document.getElementById('disciplineList');
  const message = document.getElementById('message');
  const submitButton = form.querySelector('button[type="submit"]');

  async function loadDisciplines() {
    try {
      const disciplines = await api.request(
        '/api/disciplines',
        { protectedRoute: true }
      );

      if (!Array.isArray(disciplines)) {
        throw new Error('Resposta inesperada da API.');
      }

      list.replaceChildren();

      if (disciplines.length === 0) {
        const empty = document.createElement('p');
        empty.textContent = 'Nenhuma disciplina cadastrada.';
        list.appendChild(empty);
        return;
      }

      for (const discipline of disciplines) {
        const item = document.createElement('div');
        item.className = 'item';

        const row = document.createElement('div');
        row.className = 'item-head';

        const name = document.createElement('strong');
        name.textContent = discipline.name;

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn-danger';
        remove.textContent = 'Excluir';

        remove.addEventListener('click', async () => {
          if (!confirm(`Excluir a disciplina "${discipline.name}"?`)) {
            return;
          }

          remove.disabled = true;

          try {
            await api.request(
              `/api/disciplines/${encodeURIComponent(discipline.id)}`,
              {
                method: 'DELETE',
                protectedRoute: true
              }
            );

            await loadDisciplines();

            api.showMessage(
              message,
              'Disciplina excluida.'
            );
          } catch (error) {
            api.showMessage(message, error.message, true);
            remove.disabled = false;
          }
        });

        row.append(name, remove);
        item.appendChild(row);
        list.appendChild(item);
      }

    } catch (error) {
      api.showMessage(message, error.message, true);

      if (!api.readSession()) {
        window.location.replace('index.html');
      }
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const name = String(
      new FormData(form).get('name') || ''
    ).trim();

    if (!name) {
      api.showMessage(
        message,
        'Informe o nome da disciplina.',
        true
      );
      return;
    }

    submitButton.disabled = true;

    try {
      await api.request('/api/disciplines', {
        method: 'POST',
        body: { name },
        protectedRoute: true
      });

      form.reset();
      await loadDisciplines();

      api.showMessage(
        message,
        'Disciplina cadastrada com sucesso.'
      );

    } catch (error) {
      api.showMessage(message, error.message, true);
    } finally {
      submitButton.disabled = false;
    }
  });

  loadDisciplines();
})();
