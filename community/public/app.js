const menuButton = document.querySelector('.menu-toggle');
const navigation = document.querySelector('#navigation');

if (menuButton && navigation) {
  menuButton.hidden = false;
  document.documentElement.classList.add('has-js');
  const closeMenu = (restoreFocus = false) => {
    menuButton.setAttribute('aria-expanded', 'false');
    menuButton.setAttribute('aria-label', 'Ouvrir la navigation');
    navigation.classList.remove('is-open');
    if (restoreFocus) menuButton.focus();
  };
  menuButton.addEventListener('click', () => {
    const opening = menuButton.getAttribute('aria-expanded') !== 'true';
    menuButton.setAttribute('aria-expanded', String(opening));
    menuButton.setAttribute('aria-label', opening ? 'Fermer la navigation' : 'Ouvrir la navigation');
    navigation.classList.toggle('is-open', opening);
  });
  navigation.addEventListener('click', event => {
    if (event.target.closest('a')) closeMenu();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menuButton.getAttribute('aria-expanded') === 'true') closeMenu(true);
  });
  document.addEventListener('click', event => {
    if (!event.target.closest('.header-inner')) closeMenu();
  });
  window.matchMedia('(min-width: 801px)').addEventListener('change', event => {
    if (event.matches) closeMenu();
  });
}

for (const button of document.querySelectorAll('[data-copy]')) {
  button.hidden = false;
  const label = button.querySelector('span');
  const status = button.closest('.command-card').querySelector('.copy-status');
  let resetTimer;
  button.addEventListener('click', async () => {
    const source = document.getElementById(button.dataset.copy);
    if (!source) return;
    clearTimeout(resetTimer);
    button.disabled = true;
    try {
      await navigator.clipboard.writeText(source.textContent);
      label.textContent = 'Copié';
      status.textContent = 'Les commandes ont été copiées dans le presse-papiers.';
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(source);
      selection?.removeAllRanges();
      selection?.addRange(range);
      source.closest('pre').focus();
      status.textContent = 'La copie automatique est indisponible. Les commandes sont sélectionnées : utilisez la commande Copier de votre appareil.';
    } finally {
      button.disabled = false;
      resetTimer = setTimeout(() => { label.textContent = 'Copier les commandes'; }, 4000);
    }
  });
}
