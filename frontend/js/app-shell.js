// The application shell - rebuilt with the component system.
//
// The shell is the persistent chrome: rail, place navigation, context header,
// member sidebar, mobile tab bar, overlays. Pages render into the workspace.

import { Component, compose } from './components/base.js';
import { ChannelList, ContextHeader, MemberList, Composer } from './components/compound.js';
import { Button, IconButton, Badge } from './components/primitives.js';
import { avatar as renderAvatar } from './components/media.js';
import { icon, el, qs } from './ui/dom.js';

// The shell instance that is mounted, so `buildShell` can be called more than
// once without stacking a second tree in the document.
let mount = null;

const STORAGE_KEYS = {
  sidebarCollapsed: 'trycord.sidebar.collapsed',
  contextSidebarOpen: 'trycord.contextSidebar.open',
  mobileTabBarHidden: 'trycord.mobileTabBar.hidden',
};

export class AppShell extends Component {
  constructor(props = {}) {
    super();
    this.props = {
      currentRoute: '/home',
      user: null,
      communities: [],
      dms: [],
      notifications: [],
      unreadCounts: {},
      presence: 'online',
      onNavigate: null,
      onProfileClick: null,
      onSettingsClick: null,
      onLogout: null,
      onChannelClick: null,
      onCategoryToggle: null,
      onChannelContextMenu: null,
      onDmClick: null,
      onSearch: null,
      onPinClick: null,
      onMemberListClick: null,
      onChannelSettingsClick: null,
      onMobileTabClick: null,
      ...props,
    };

    this._channelList = null;
    this._contextHeader = null;
    this._memberList = null;
    this._composer = null;
    this._mobileTabBar = null;
    this._backdrop = null;
  }

  render() {
    // The tree this shell draws is the one the rest of the application already
    // addresses by id: the same regions, the same contracts, the same overlays.
    return el('section', { id: 'shell', class: 'shell', 'aria-label': 'Trycord' }, [
      el('aside', { id: 'app-rail', class: 'app-rail', 'aria-label': 'Navigation' }, [
        this.renderIdentity(),
        this.renderGlobalNav(),
        this.renderCommunityNav(this.props.communities),
        this.renderRailFoot(this.props.user),
      ]),

      el('section', {
        id: 'place-navigation',
        class: 'context-sidebar',
        'aria-label': 'Current place navigation',
      }),

      el('main', { id: 'trycord-main', class: 'main-content' }, [
        el('header', { id: 'context-header', class: 'context-header' }),
        el('div', { class: 'chat-environment' }, [
          el('section', { id: 'view-root', class: 'view-root' }),
          el('aside', {
            id: 'member-sidebar',
            class: 'member-sidebar',
            'aria-label': 'Community members',
          }),
        ]),
      ]),

      el('div', { id: 'desktop-backdrop', class: 'nav-backdrop', 'aria-hidden': 'true', hidden: true }),
      el('nav', { id: 'mobile-tab-navigation', class: 'mobile-tab-navigation', 'aria-label': 'Primary navigation' }),
      el('div', { id: 'modal-root', class: 'modal-root' }),
      el('div', { id: 'popover-root', class: 'popover-root' }),
      el('div', { id: 'route-announcer', class: 'sr-only', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }),
      el('div', { id: 'toast-root', class: 'toast-root', 'aria-live': 'polite', 'aria-atomic': 'true' }),
      el('div', { id: 'connection-status', class: 'connection-status', role: 'status', 'aria-live': 'polite' }),
    ]);
  }

  onMount() {
    mount = this;
    this.restoreState();
    this.bindKeyboardShortcuts();
  }

  onUnmount() {
    if (mount === this) mount = null;
  }

  update(props) {
    this.props = { ...this.props, ...props };
    this.render();
    if (this._root && this._root.parentNode) {
      this._root.parentNode.replaceChild(this._root, this._root);
    }
    return this;
  }

  restoreState() {
    try {
      const collapsed = localStorage.getItem(STORAGE_KEYS.sidebarCollapsed) === 'true';
      if (collapsed) document.body.classList.add('sidebar-collapsed');
    } catch { /* private mode */ }
  }

  persistState(key, value) {
    try {
      localStorage.setItem(key, String(value));
    } catch { /* private mode */ }
  }

  bindKeyboardShortcuts() {
    this.on(document, 'keydown', (e) => {
      // Cmd/Ctrl + K = search
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        this.props.onSearch?.();
      }
      // Cmd/Ctrl + Shift + M = toggle member list
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'M') {
        e.preventDefault();
        this.toggleContextSidebar();
      }
      // Cmd/Ctrl + B = toggle sidebar
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault();
        this.toggleSidebar();
      }
      // Escape = close modals/drawers
      if (e.key === 'Escape') {
        this.closeDrawers();
      }
    });
  }

  // --- Rail ---

  renderIdentity() {
    const { user, presence, onProfileClick } = this.props;

    return el('header', { id: 'identity-region', class: 'rail-identity' }, [
      el('button', {
        id: 'identity-button',
        class: 'identity-button',
        'aria-label': 'Your profile',
        type: 'button',
      }, [
        renderAvatar(user || {}, { size: 'md', withPresence: presence !== 'offline' }),
        el('div', { class: 'identity-info' }, [
          el('span', { class: 'identity-name' }, user?.display_name || user?.username || 'You'),
          el('span', { class: 'identity-status' }, this.formatPresence(presence)),
        ]),
      ]),
    ]);
  }

  renderGlobalNav() {
    const { currentRoute, unreadCounts, onNavigate } = this.props;

    const navItems = [
      { id: 'home', route: '/home', icon: 'home', label: 'Home', short: 'Home' },
      { id: 'dms', route: '/dms', icon: 'mail', label: 'Direct Messages', short: 'DMs', count: unreadCounts.dms },
      { id: 'friends', route: '/friends', icon: 'users', label: 'Friends', short: 'Friends', count: unreadCounts.friends },
      { id: 'notifications', route: '/notifications', icon: 'bell', label: 'Notifications', short: 'Alerts', count: unreadCounts.notifications },
      { id: 'discover', route: '/discover', icon: 'compass', label: 'Discover', short: 'Discover' },
      { id: 'settings', route: '/settings', icon: 'settings', label: 'Settings', short: 'Settings' },
    ];

    return el('nav', { id: 'global-navigation', class: 'rail-global-nav', 'aria-label': 'Global navigation' }, [
      ...navItems.map((item) => {
        const isActive = currentRoute?.startsWith(item.route) && item.route !== '/home' ||
          currentRoute === item.route;

        const btn = new Button({
          variant: isActive ? 'primary' : 'ghost',
          size: 'md',
          fullWidth: true,
          icon: item.icon,
          children: item.short,
          pressed: isActive,
          'aria-label': item.label,
          'aria-current': isActive ? 'page' : undefined,
          onClick: () => onNavigate?.(item.route),
        });

        if (item.count && item.count > 0) {
          const badge = new Badge({
            children: item.count > 99 ? '99+' : item.count,
            variant: item.id === 'notifications' ? 'danger' : 'brand',
            size: 'xs',
            dot: item.id !== 'notifications',
          });
          // Insert badge after icon
          btn.onMount = () => {
            const text = btn.root.querySelector('.btn__text');
            if (text) text.before(badge.root);
          };
        }

        return btn;
      }),
    ]);
  }

  renderCommunityNav(communities) {
    const { onNavigate } = this.props;

    const section = el('section', { id: 'community-navigation', class: 'app-rail__items', 'aria-label': 'Communities' });

    if (communities.length === 0) {
      const empty = el('button', {
        class: 'community-empty',
        type: 'button',
      }, [
        icon('plus'),
        el('span', {}, 'Add a community'),
      ]);
      this.on(empty, 'click', () => onNavigate?.('/servers/new'));
      section.appendChild(empty);
      return section;
    }

    for (const community of communities) {
      const unread = this.props.unreadCounts?.communities?.[community.id] || 0;
      const btn = new Button({
        variant: 'ghost',
        size: 'md',
        fullWidth: true,
        icon: community.icon_url ? null : 'layers',
        children: community.name,
        pressed: this.props.currentRoute?.startsWith(`/server/${community.id}`) || this.props.currentRoute?.startsWith(`/c/${community.slug}`),
        'aria-label': community.name,
        onClick: () => onNavigate?.(`/c/${community.slug}`),
      });
      if (community.icon_url) {
        // Custom community icon
        btn.onMount = () => {
          const iconEl = btn.root.querySelector('.btn__text');
          if (iconEl) {
            const img = document.createElement('img');
            img.src = community.icon_url;
            img.alt = '';
            img.className = 'community-icon';
            iconEl.before(img);
          }
        };
      }
      if (unread > 0) {
        const badge = new Badge({ children: unread > 99 ? '99+' : unread, variant: 'brand', size: 'xs' });
        btn.onMount = () => {
          const text = btn.root.querySelector('.btn__text');
          if (text) text.before(badge.root);
        };
      }
      btn.mount(section);
    }

    // Add community button
    const addBtn = el('button', {
      id: 'add-community-button',
      class: 'community-add',
      type: 'button',
      'aria-label': 'Add a community',
    }, [icon('plus')]);
    this.on(addBtn, 'click', () => onNavigate?.('/servers/new'));
    section.appendChild(addBtn);

    return section;
  }

  renderRailFoot(user) {
    const { onSettingsClick, onLogout } = this.props;

    return el('footer', { id: 'rail-foot', class: 'rail-foot', 'aria-label': 'Account' }, [
      new Button({
        variant: 'ghost',
        size: 'sm',
        fullWidth: true,
        icon: 'settings',
        children: 'Settings',
        onClick: onSettingsClick,
      }).root,
      el('hr', { class: 'rail-foot__divider' }),
      new Button({
        variant: 'ghost',
        size: 'sm',
        fullWidth: true,
        icon: 'log-out',
        children: 'Log out',
        onClick: onLogout,
      }).root,
    ]);
  }

  updateRail() {
    // Re-render rail regions
    const rail = qs('#app-rail');
    if (rail) {
      rail.replaceChildren(
        this.renderIdentity(),
        this.renderGlobalNav(),
        this.renderCommunityNav(this.props.communities),
        this.renderRailFoot(this.props.user)
      );
    }
  }

  // --- Place Navigation (Channel List) ---

  updatePlaceNav() {
    if (this._channelList) {
      this._channelList.update({
        categories: this.props.currentCategories || [],
        activeChannelId: this.props.activeChannelId,
        collapsedCategories: this.props.collapsedCategories || new Set(),
      });
    }
  }

  // --- Context Header ---

  updateContextHeader() {
    if (this._contextHeader) {
      this._contextHeader.update({
        channel: this.props.currentChannel,
        topic: this.props.currentChannel?.topic,
        memberCount: this.props.currentChannel?.member_count,
      });
    }
  }

  // --- Member List ---

  updateMemberList() {
    if (this._memberList) {
      this._memberList.update({
        members: this.props.currentMembers || [],
        filter: this.props.memberFilter || '',
      });
    }
  }

  // --- Mobile Tab Bar ---

  updateMobileTabBar() {
    if (!this._mobileTabBar) return;

    const { currentRoute, unreadCounts } = this.props;

    const tabs = [
      { id: 'home', route: '/home', icon: 'home', label: 'Home' },
      { id: 'dms', route: '/dms', icon: 'mail', label: 'DMs', count: unreadCounts.dms },
      { id: 'friends', route: '/friends', icon: 'users', label: 'Friends', count: unreadCounts.friends },
      { id: 'notifications', route: '/notifications', icon: 'bell', label: 'Alerts', count: unreadCounts.notifications },
      { id: 'menu', route: '/menu', icon: 'menu', label: 'Menu' },
    ];

    this._mobileTabBar.replaceChildren(
      ...tabs.map((tab) => {
        const isActive = currentRoute?.startsWith(tab.route) && tab.route !== '/home' ||
          currentRoute === tab.route;

        const btn = new Button({
          variant: isActive ? 'primary' : 'ghost',
          size: 'sm',
          icon: tab.icon,
          children: tab.label,
          pressed: isActive,
          'aria-label': tab.label,
          'aria-current': isActive ? 'page' : undefined,
          onClick: () => this.props.onNavigate?.(tab.route),
        });

        if (tab.count && tab.count > 0) {
          const badge = new Badge({
            children: tab.count > 99 ? '99+' : tab.count,
            variant: tab.id === 'notifications' ? 'danger' : 'brand',
            size: 'xs',
            dot: true,
          });
          btn.onMount = () => {
            const text = btn.root.querySelector('.btn__text');
            if (text) text.before(badge.root);
          };
        }

        return btn.root;
      })
    );
  }

  // --- Sidebar toggles ---

  toggleSidebar() {
    const collapsed = !document.body.classList.toggle('sidebar-collapsed');
    this.persistState(STORAGE_KEYS.sidebarCollapsed, collapsed);
  }

  toggleContextSidebar() {
    const open = document.body.classList.toggle('context-sidebar-open');
    this.persistState(STORAGE_KEYS.contextSidebarOpen, open);
    this.updateBackdrop();
  }

  closeDrawers() {
    document.body.classList.remove('context-sidebar-open');
    this.persistState(STORAGE_KEYS.contextSidebarOpen, false);
    this.updateBackdrop();
  }

  updateBackdrop() {
    const open = document.body.classList.contains('context-sidebar-open') ||
      document.body.classList.contains('sidebar-open');
    if (this._backdrop) {
      this._backdrop.hidden = !open;
    }
  }

  formatPresence(presence) {
    const labels = {
      online: 'Online',
      idle: 'Idle',
      dnd: 'Do Not Disturb',
      offline: 'Offline',
      streaming: 'Streaming',
    };
    return labels[presence] || 'Online';
  }
}

/** Build the shell tree into the mount point. */
export function buildShell(props = {}) {
  const mount = document.getElementById('app');
  if (!mount) return null;

  const shell = new AppShell(props);
  shell.mount(mount);
  return shell;
}

export { icon } from './ui/dom.js';