// Developer Portal Home Page
//
// Shows the portal navigation cards for different areas:
// - API Keys management
// - Applications management
// - Documentation
// - Communities (if user is owner/admin)

import { el } from '../../packages/dom.js';
import { head, fold } from '../../packages/ui/page.js';
import { refreshServers } from '../../packages/store.js';

// Portal configuration
const ROUTES = {
  KEYS: '/applications/keys',
  APPLICATIONS: '/applications/applications',
  DOCUMENTATION: '/applications/documentation',
};

/**
 * Render the portal home page
 * @returns {Object} Page with node, onMount, and cleanup methods
 */
function render() {
  const container = el('div', { class: 'fold fold--tight' });

  // Initialize and load server data
  const loadServerData = async () => {
    if (!State.servers || !State.servers.length) {
      try {
        await refreshServers();
      } catch (error) {
        console.warn('Failed to load servers:', error);
      }
    }
  };

  // Paint the page content
  const paint = async () => {
    await loadServerData();

    // Check if user manages any servers
    const isManager = State.servers && State.servers.some(server => {
      const hasManagePerm = server.permissions && (
        server.permissions.includes('*') ||
        server.permissions.includes('MANAGE_SERVER')
      );
      return hasManagePerm || server.is_owner;
    });

    // Build the navigation cards
    container.replaceChildren(
      fold([
        head({ label: 'Developer Portal' }),

        // API Keys card
        createCard({
          label: 'API Keys',
          description: 'Manage credentials and authorization tokens',
          onClick: () => (window.location.href = ROUTES.KEYS),
        }),

        // Applications card
        createCard({
          label: 'Applications',
          description: 'Create, configure and manage your applications and bots',
          onClick: () => (window.location.href = ROUTES.APPLICATIONS),
        }),

        // Documentation card
        createCard({
          label: 'Documentation',
          description: 'Learn how to build with Trycord',
          onClick: () => (window.location.href = ROUTES.DOCUMENTATION),
        }),

        // Communities card (only for managers)
        isManager
          ? createCard({
              label: 'Communities',
              description: 'Your managed communities with integrations',
              onClick: () => (window.location.href = ROUTES.APPLICATIONS),
            })
          : null,
      ])
    );
  };

  return {
    node: container,
    onMount: paint,
    cleanup: () => {},
  };
}

/**
 * Create a navigation card component
 * @param {Object} options - Card configuration
 * @param {string} options.label - Card title
 * @param {string} options.description - Card description
 * @param {Function} options.onClick - Click handler
 * @returns {HTMLElement} The card element
 */
function createCard({ label, description, onClick }) {
  return el('div', { class: 'settings-item' },
    el('div', { class: 'settings-item-main' },
      el('p', { class: 'settings-item-label' }, label),
      el('p', { class: 'settings-note' }, description)),
    el('div', { class: 'settings-item-control' },
      el('button', {
        type: 'button',
        class: 'btn btn--primary btn--sm',
        onClick,
      }, label))
  );
}

// Export the page renderer
export default { render };