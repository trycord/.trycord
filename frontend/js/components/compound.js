// Compound components. These are molecules and organisms built from primitives.
// They contain layout logic and may have internal state, but no business logic.

import { Component } from './base.js';
import { Button, Input, Badge, Divider, Tooltip, IconButton } from './primitives.js';
import { avatar } from './media.js';
import { icon } from '../ui/dom.js';

/**
 * UserCard - user preview with avatar, name, status, and actions.
 */
export class UserCard extends Component {
  constructor(props = {}) {
    super();
    this.props = {
      user: null,
      variant: 'default', // default, compact, detailed
      showStatus: true,
      showActions: false,
      onClick: null,
      ...props,
    };
  }

  render() {
    const { user, variant, showStatus, showActions, onClick } = this.props;

    if (!user) return document.createTextNode('');

    const wrapper = document.createElement('div');
    wrapper.className = `user-card user-card--${variant}`;

    const avatarEl = avatar(user, {
      size: variant === 'compact' ? 'sm' : 'md',
      withPresence: showStatus,
    });
    if (onClick) {
      avatarEl.classList.add('avatar--clickable');
      avatarEl.addEventListener('click', onClick);
    }
    wrapper.appendChild(avatarEl);

    const info = document.createElement('div');
    info.className = 'user-card__info';

    const nameRow = document.createElement('div');
    nameRow.className = 'user-card__name-row';

    const name = document.createElement('span');
    name.className = 'user-card__name';
    name.textContent = user.display_name || user.username || 'Unknown';
    nameRow.appendChild(name);

    if (user.bot) {
      const botBadge = new Badge({ children: 'Bot', variant: 'brand', size: 'sm' });
      botBadge.mount(nameRow);
    }

    info.appendChild(nameRow);

    if (variant === 'detailed' && user.bio) {
      const bio = document.createElement('p');
      bio.className = 'user-card__bio';
      bio.textContent = user.bio;
      info.appendChild(bio);
    }

    if (variant !== 'compact' && (user.status_text || user.email)) {
      const meta = document.createElement('div');
      meta.className = 'user-card__meta';
      if (user.status_text) {
        const status = document.createElement('span');
        status.className = 'user-card__status-text';
        status.textContent = user.status_text;
        meta.appendChild(status);
      }
      if (user.email && variant === 'detailed') {
        const email = document.createElement('span');
        email.textContent = user.email;
        meta.appendChild(email);
      }
      info.appendChild(meta);
    }

    wrapper.appendChild(info);

    if (showActions && this.props.actions) {
      const actions = document.createElement('div');
      actions.className = 'user-card__actions';
      for (const action of this.props.actions) {
        const btn = new Button({
          variant: 'ghost',
          size: 'sm',
          icon: action.icon,
          'aria-label': action.label,
          onClick: action.handler,
        });
        btn.mount(actions);
      }
      wrapper.appendChild(actions);
    }

    return wrapper;
  }
}

/**
 * ChannelItem - a channel in the sidebar/list.
 */
export class ChannelItem extends Component {
  constructor(props = {}) {
    super();
    this.props = {
      channel: null,
      active: false,
      unread: false,
      mention: false,
      collapsed: false,
      onClick: null,
      onContextMenu: null,
      ...props,
    };
  }

  render() {
    const { channel, active, unread, mention, collapsed, onClick, onContextMenu } = this.props;

    if (!channel) return document.createTextNode('');

    const wrapper = document.createElement('button');
    wrapper.type = 'button';
    wrapper.className = `channel-item ${active ? 'channel-item--active' : ''} ${unread ? 'channel-item--unread' : ''} ${mention ? 'channel-item--mention' : ''} ${collapsed ? 'channel-item--collapsed' : ''}`;
    if (onClick) this.on(wrapper, 'click', onClick);
    if (onContextMenu) this.on(wrapper, 'contextmenu', onContextMenu);

    const iconType = channel.type === 'voice' ? 'volume-2' : channel.type === 'announcement' ? 'megaphone' : channel.type === 'forum' ? 'message-square' : 'hash';
    const iconEl = icon(iconType);
    iconEl.className = 'channel-item__icon';
    wrapper.appendChild(iconEl);

    const name = document.createElement('span');
    name.className = 'channel-item__name';
    name.textContent = channel.name || 'unnamed';
    wrapper.appendChild(name);

    if (unread || mention) {
      const badge = new Badge({
        children: mention ? '●' : '',
        variant: mention ? 'danger' : 'brand',
        size: 'sm',
        dot: true,
      });
      badge.mount(wrapper);
    }

    return wrapper;
  }
}

/**
 * ChannelList - list of channels with category grouping.
 */
export class ChannelList extends Component {
  constructor(props = {}) {
    super();
    this.props = {
      categories: [],
      activeChannelId: null,
      collapsedCategories: new Set(),
      onChannelClick: null,
      onCategoryToggle: null,
      onChannelContextMenu: null,
      ...props,
    };
  }

  render() {
    const { categories, activeChannelId, collapsedCategories, onChannelClick, onCategoryToggle, onChannelContextMenu } = this.props;

    const wrapper = document.createElement('nav');
    wrapper.className = 'channel-list';
    wrapper.setAttribute('aria-label', 'Channels');

    for (const category of categories) {
      const isCollapsed = collapsedCategories.has(category.id);

      const catHeader = document.createElement('div');
      catHeader.className = `channel-category ${isCollapsed ? 'channel-category--collapsed' : ''}`;

      const catButton = document.createElement('button');
      catButton.type = 'button';
      catButton.className = 'channel-category__header';
      if (onCategoryToggle) this.on(catButton, 'click', () => onCategoryToggle(category.id));

      const catIcon = icon(isCollapsed ? 'chevron-right' : 'chevron-down');
      catIcon.className = 'channel-category__icon';
      catButton.appendChild(catIcon);

      const catName = document.createElement('span');
      catName.className = 'channel-category__name';
      catName.textContent = category.name || 'Uncategorized';
      catButton.appendChild(catName);

      if (category.unread_count > 0) {
        const badge = new Badge({
          children: category.unread_count > 99 ? '99+' : category.unread_count,
          variant: 'brand',
          size: 'sm',
        });
        badge.mount(catButton);
      }

      catHeader.appendChild(catButton);
      wrapper.appendChild(catHeader);

      if (!isCollapsed && category.channels?.length) {
        const list = document.createElement('div');
        list.className = 'channel-category__channels';

        for (const channel of category.channels) {
          const item = new ChannelItem({
            channel,
            active: channel.id === activeChannelId,
            unread: channel.unread_count > 0 && !channel.mention_count,
            mention: channel.mention_count > 0,
            collapsed: false,
            onClick: () => onChannelClick?.(channel),
            onContextMenu: (e) => onChannelContextMenu?.(channel, e),
          });
          item.mount(list);
        }

        catHeader.appendChild(list);
      }
    }

    return wrapper;
  }
}

/**
 * Message - a single message in the chat.
 */
export class Message extends Component {
  constructor(props = {}) {
    super();
    this.props = {
      message: null,
      currentUserId: null,
      showAvatar: true,
      compact: false,
      onReply: null,
      onReact: null,
      onEdit: null,
      onDelete: null,
      onThreadOpen: null,
      ...props,
    };
  }

  render() {
    const { message, currentUserId, showAvatar, compact, onReply, onReact, onEdit, onDelete, onThreadOpen } = this.props;

    if (!message) return document.createTextNode('');

    const isOwn = message.author_id === currentUserId;
    const hasThread = message.thread_id && message.thread_message_count > 0;

    const wrapper = document.createElement('article');
    wrapper.className = `message ${isOwn ? 'message--own' : ''} ${compact ? 'message--compact' : ''} ${hasThread ? 'message--has-thread' : ''}`;
    wrapper.dataset.messageId = message.id;

    if (!compact && showAvatar) {
      const author = {
        id: message.author_id,
        username: message.author_username,
        display_name: message.author_display_name,
        avatar_url: message.author_avatar_url,
      };
      const avatarEl = avatar(author, { size: 'sm' });
      wrapper.appendChild(avatarEl);
    }

    const content = document.createElement('div');
    content.className = 'message__content';

    if (!compact) {
      const header = document.createElement('header');
      header.className = 'message__header';

      const author = document.createElement('span');
      author.className = 'message__author';
      author.textContent = message.author_display_name || message.author_username || 'Unknown';
      header.appendChild(author);

      const timestamp = document.createElement('time');
      timestamp.className = 'message__timestamp';
      timestamp.dateTime = message.created_at;
      timestamp.textContent = this.formatTime(message.created_at);
      header.appendChild(timestamp);

      if (message.edited_at) {
        const edited = document.createElement('span');
        edited.className = 'message__edited';
        edited.textContent = 'edited';
        header.appendChild(edited);
      }

      if (isOwn) {
        const actions = document.createElement('div');
        actions.className = 'message__actions';
        if (onReply) {
          const replyBtn = new IconButton({ icon: 'reply', 'aria-label': 'Reply', size: 'sm', onClick: () => onReply(message) });
          replyBtn.mount(actions);
        }
        if (onReact) {
          const reactBtn = new IconButton({ icon: 'smile', 'aria-label': 'Add reaction', size: 'sm', onClick: () => onReact(message) });
          reactBtn.mount(actions);
        }
        if (onEdit) {
          const editBtn = new IconButton({ icon: 'edit', 'aria-label': 'Edit', size: 'sm', onClick: () => onEdit(message) });
          editBtn.mount(actions);
        }
        if (onDelete) {
          const deleteBtn = new IconButton({ icon: 'trash-2', variant: 'danger', 'aria-label': 'Delete', size: 'sm', onClick: () => onDelete(message) });
          deleteBtn.mount(actions);
        }
        if (hasThread && onThreadOpen) {
          const threadBtn = new IconButton({ icon: 'message-square', 'aria-label': 'Open thread', size: 'sm', onClick: () => onThreadOpen(message) });
          threadBtn.mount(actions);
        }
        header.appendChild(actions);
      }

      content.appendChild(header);
    }

    const body = document.createElement('div');
    body.className = 'message__body';
    // Message content rendering would go here - BBCode/Markdown parser output
    body.innerHTML = message.rendered_content || this.escapeHtml(message.content);
    content.appendChild(body);

    if (message.attachments?.length) {
      const attachments = document.createElement('div');
      attachments.className = 'message__attachments';
      for (const att of message.attachments) {
        const attEl = document.createElement('a');
        attEl.href = att.url;
        attEl.className = 'attachment';
        attEl.target = '_blank';
        attEl.rel = 'noopener noreferrer';
        if (att.is_image) {
          const img = document.createElement('img');
          img.src = att.url;
          img.alt = att.filename;
          img.loading = 'lazy';
          attEl.appendChild(img);
        } else {
          const fileIcon = icon('file');
          fileIcon.className = 'attachment__icon';
          attEl.appendChild(fileIcon);
          const name = document.createElement('span');
          name.className = 'attachment__name';
          name.textContent = att.filename;
          attEl.appendChild(name);
        }
        attachments.appendChild(attEl);
      }
      content.appendChild(attachments);
    }

    if (message.embeds?.length) {
      const embeds = document.createElement('div');
      embeds.className = 'message__embeds';
      // Embed rendering would go here
      content.appendChild(embeds);
    }

    if (message.reactions?.length) {
      const reactions = document.createElement('div');
      reactions.className = 'message__reactions';
      for (const reaction of message.reactions) {
        const reactionEl = document.createElement('button');
        reactionEl.type = 'button';
        reactionEl.className = `reaction ${reaction.me ? 'reaction--me' : ''}`;
        reactionEl.dataset.emoji = reaction.emoji;

        const emoji = document.createElement('span');
        emoji.className = 'reaction__emoji';
        emoji.textContent = reaction.emoji;
        reactionEl.appendChild(emoji);

        const count = document.createElement('span');
        count.className = 'reaction__count';
        count.textContent = reaction.count;
        reactionEl.appendChild(count);

        this.on(reactionEl, 'click', () => onReact?.(message, reaction.emoji));
        reactions.appendChild(reactionEl);
      }
      content.appendChild(reactions);
    }

    if (hasThread) {
      const threadPreview = document.createElement('button');
      threadPreview.type = 'button';
      threadPreview.className = 'message__thread-preview';
      threadPreview.textContent = `${message.thread_message_count} ${message.thread_message_count === 1 ? 'reply' : 'replies'}`;
      this.on(threadPreview, 'click', () => onThreadOpen?.(message));
      content.appendChild(threadPreview);
    }

    wrapper.appendChild(content);

    return wrapper;
  }

  formatTime(iso) {
    const date = new Date(iso);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

/**
 * MessageList - virtualized list of messages.
 */
export class MessageList extends Component {
  constructor(props = {}) {
    super();
    this.props = {
      messages: [],
      currentUserId: null,
      onReply: null,
      onReact: null,
      onEdit: null,
      onDelete: null,
      onThreadOpen: null,
      loading: false,
      hasMore: false,
      onLoadMore: null,
      ...props,
    };
  }

  render() {
    const { messages, currentUserId, onReply, onReact, onEdit, onDelete, onThreadOpen, loading, hasMore, onLoadMore } = this.props;

    const wrapper = document.createElement('div');
    wrapper.className = 'message-list';
    wrapper.setAttribute('role', 'log');
    wrapper.setAttribute('aria-live', 'polite');
    wrapper.setAttribute('aria-atomic', 'false');

    if (messages.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'message-list__empty';
      empty.textContent = 'No messages yet. Start the conversation!';
      wrapper.appendChild(empty);
    } else {
      for (const message of messages) {
        const msg = new Message({
          message,
          currentUserId,
          onReply,
          onReact,
          onEdit,
          onDelete,
          onThreadOpen,
        });
        msg.mount(wrapper);
      }
    }

    if (loading) {
      const loader = document.createElement('div');
      loader.className = 'message-list__loader';
      loader.textContent = 'Loading...';
      wrapper.appendChild(loader);
    } else if (hasMore && onLoadMore) {
      const loadBtn = new Button({
        variant: 'ghost',
        size: 'sm',
        children: 'Load more',
        onClick: onLoadMore,
      });
      loadBtn.mount(wrapper);
    }

    return wrapper;
  }
}

/**
 * Composer - message input with attachments, mentions, commands.
 */
export class Composer extends Component {
  constructor(props = {}) {
    super();
    this.props = {
      value: '',
      placeholder: 'Message #channel...',
      disabled: false,
      attachments: [],
      onSend: null,
      onAttachmentAdd: null,
      onAttachmentRemove: null,
      onMentionRequest: null,
      ...props,
    };
    this._textarea = null;
  }

  render() {
    const { value, placeholder, disabled, attachments, onAttachmentRemove } = this.props;

    const wrapper = document.createElement('div');
    wrapper.className = 'composer';

    if (attachments.length) {
      const attBar = document.createElement('div');
      attBar.className = 'composer__attachments';
      for (const att of attachments) {
        const item = document.createElement('div');
        item.className = 'composer__attachment';
        const name = document.createElement('span');
        name.className = 'composer__attachment-name';
        name.textContent = att.name;
        item.appendChild(name);
        const remove = new IconButton({
          icon: 'x',
          size: 'sm',
          variant: 'ghost',
          'aria-label': 'Remove attachment',
          onClick: () => onAttachmentRemove?.(att.id),
        });
        remove.mount(item);
        attBar.appendChild(item);
      }
      wrapper.appendChild(attBar);
    }

    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'composer__input-wrapper';

    const textarea = document.createElement('textarea');
    textarea.className = 'composer__textarea';
    textarea.placeholder = placeholder;
    textarea.value = value;
    textarea.disabled = disabled;
    textarea.rows = 1;
    this._textarea = textarea;

    this.on(textarea, 'input', (e) => {
      this.props.value = e.target.value;
      // Auto-resize
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
      if (this.props.onChange) this.props.onChange(e.target.value, e);
    });
    this.on(textarea, 'keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (this.props.onSend) this.props.onSend(e.target.value.trim());
        e.target.value = '';
        this.props.value = '';
        textarea.style.height = 'auto';
      }
      if (this.props.onKeyDown) this.props.onKeyDown(e);
    });

    inputWrapper.appendChild(textarea);

    const actions = document.createElement('div');
    actions.className = 'composer__actions';

    const attachBtn = new IconButton({
      icon: 'paperclip',
      'aria-label': 'Attach file',
      variant: 'ghost',
      onClick: () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.onchange = (e) => {
          for (const file of e.target.files) {
            this.props.onAttachmentAdd?.(file);
          }
        };
        input.click();
      },
    });
    attachBtn.mount(actions);

    const sendBtn = new Button({
      variant: 'primary',
      size: 'sm',
      icon: 'send',
      disabled: !value.trim() || disabled,
      onClick: () => {
        if (this.props.onSend) this.props.onSend(value.trim());
        textarea.value = '';
        this.props.value = '';
        textarea.style.height = 'auto';
      },
    });
    sendBtn.mount(actions);

    inputWrapper.appendChild(actions);
    wrapper.appendChild(inputWrapper);

    return wrapper;
  }

  focus() {
    this._textarea?.focus();
  }
}

/**
 * ThreadView - thread panel that opens alongside a message.
 */
export class ThreadView extends Component {
  constructor(props = {}) {
    super();
    this.props = {
      parentMessage: null,
      messages: [],
      currentUserId: null,
      onReply: null,
      onReact: null,
      onClose: null,
      ...props,
    };
  }

  render() {
    const { parentMessage, messages, currentUserId, onReply, onReact, onClose } = this.props;

    const wrapper = document.createElement('aside');
    wrapper.className = 'thread-view';
    wrapper.setAttribute('aria-label', 'Thread');

    const header = document.createElement('header');
    header.className = 'thread-view__header';

    const backBtn = new IconButton({
      icon: 'chevron-left',
      'aria-label': 'Close thread',
      variant: 'ghost',
      onClick: onClose,
    });
    backBtn.mount(header);

    const title = document.createElement('h2');
    title.className = 'thread-view__title';
    title.textContent = 'Thread';
    header.appendChild(title);

    wrapper.appendChild(header);

    if (parentMessage) {
      const parent = new Message({
        message: parentMessage,
        currentUserId,
        compact: true,
        onReply,
        onReact,
      });
      parent.mount(wrapper);
      const divider = new Divider({ variant: 'subtle' });
      divider.mount(wrapper);
    }

    const list = new MessageList({
      messages,
      currentUserId,
      onReply,
      onReact,
    });
    list.mount(wrapper);

    const composer = new Composer({
      placeholder: 'Reply to thread...',
      onSend: onReply,
    });
    composer.mount(wrapper);

    return wrapper;
  }
}

/**
 * ContextHeader - the header above the message list showing channel info.
 */
export class ContextHeader extends Component {
  constructor(props = {}) {
    super();
    this.props = {
      channel: null,
      topic: '',
      memberCount: 0,
      onSettings: null,
      onSearch: null,
      onPin: null,
      onMemberList: null,
      ...props,
    };
  }

  render() {
    const { channel, topic, memberCount, onSettings, onSearch, onPin, onMemberList } = this.props;

    if (!channel) return document.createTextNode('');

    const header = document.createElement('header');
    header.className = 'context-header';

    const left = document.createElement('div');
    left.className = 'context-header__left';

    const backBtn = new IconButton({
      icon: 'chevron-left',
      'aria-label': 'Back',
      variant: 'ghost',
      onClick: () => window.history.back(),
    });
    backBtn.mount(left);

    const iconType = channel.type === 'voice' ? 'volume-2' : channel.type === 'announcement' ? 'megaphone' : channel.type === 'forum' ? 'message-square' : 'hash';
    const channelIcon = icon(iconType);
    channelIcon.className = 'context-header__icon';
    left.appendChild(channelIcon);

    const name = document.createElement('h1');
    name.className = 'context-header__name';
    name.textContent = channel.name;
    left.appendChild(name);

    if (channel.topic) {
      const topicEl = document.createElement('p');
      topicEl.className = 'context-header__topic';
      topicEl.textContent = channel.topic;
      left.appendChild(topicEl);
    }

    header.appendChild(left);

    const right = document.createElement('div');
    right.className = 'context-header__right';

    if (onSearch) {
      const searchBtn = new IconButton({
        icon: 'search',
        'aria-label': 'Search in channel',
        variant: 'ghost',
        onClick: onSearch,
      });
      searchBtn.mount(right);
    }

    if (onPin) {
      const pinBtn = new IconButton({
        icon: 'pin',
        'aria-label': 'Pinned messages',
        variant: 'ghost',
        onClick: onPin,
      });
      pinBtn.mount(right);
    }

    if (onMemberList) {
      const membersBtn = new IconButton({
        icon: 'users',
        'aria-label': `Members (${memberCount})`,
        variant: 'ghost',
        onClick: onMemberList,
      });
      membersBtn.mount(right);
    }

    if (onSettings) {
      const settingsBtn = new IconButton({
        icon: 'settings',
        'aria-label': 'Channel settings',
        variant: 'ghost',
        onClick: onSettings,
      });
      settingsBtn.mount(right);
    }

    header.appendChild(right);

    return header;
  }
}

/**
 * MemberList - community member sidebar.
 */
export class MemberList extends Component {
  constructor(props = {}) {
    super();
    this.props = {
      members: [],
      currentUserId: null,
      onMemberClick: null,
      onMemberAction: null,
      filter: '',
      ...props,
    };
  }

  render() {
    const { members, currentUserId, onMemberClick, onMemberAction, filter } = this.props;

    const wrapper = document.createElement('aside');
    wrapper.className = 'member-list';
    wrapper.setAttribute('aria-label', 'Members');

    const header = document.createElement('div');
    header.className = 'member-list__header';

    const title = document.createElement('h2');
    title.textContent = `Members (${members.length})`;
    header.appendChild(title);

    const search = new Input({
      placeholder: 'Filter members...',
      value: filter,
      icon: 'search',
      onChange: (value) => this.props.onFilter?.(value),
    });
    search.mount(header);

    wrapper.appendChild(header);

    const list = document.createElement('div');
    list.className = 'member-list__items';

    const filtered = members.filter((m) =>
      (m.username || '').toLowerCase().includes(filter.toLowerCase()) ||
      (m.display_name || '').toLowerCase().includes(filter.toLowerCase())
    );

    for (const member of filtered) {
      const isOwn = member.user_id === currentUserId;
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `member-list__item ${isOwn ? 'member-list__item--own' : ''}`;

      const avatarEl = avatar(member, { size: 'sm' });
      avatarEl.classList.add('avatar--clickable');
      avatarEl.addEventListener('click', () => onMemberClick?.(member));
      item.appendChild(avatar);

      const info = document.createElement('div');
      info.className = 'member-list__info';

      const nameRow = document.createElement('div');
      nameRow.className = 'member-list__name-row';

      const name = document.createElement('span');
      name.className = 'member-list__name';
      name.textContent = member.display_name || member.username || 'Unknown';
      nameRow.appendChild(name);

      if (member.bot) {
        const badge = new Badge({ children: 'Bot', variant: 'brand', size: 'xs' });
        badge.mount(nameRow);
      }

      if (isOwn) {
        const you = document.createElement('span');
        you.className = 'member-list__you';
        you.textContent = 'You';
        nameRow.appendChild(you);
      }

      info.appendChild(nameRow);

      if (member.roles?.length) {
        const roles = document.createElement('div');
        roles.className = 'member-list__roles';
        for (const role of member.roles) {
          const roleBadge = new Badge({
            children: role.name,
            variant: 'default',
            size: 'xs',
          });
          roleBadge.mount(roles);
        }
        info.appendChild(roles);
      }

      item.appendChild(info);

      const actionsBtn = new IconButton({
        icon: 'more-horizontal',
        'aria-label': 'Member actions',
        variant: 'ghost',
        size: 'sm',
        onClick: (e) => {
          e.stopPropagation();
          onMemberAction?.(member, item);
        },
      });
      actionsBtn.mount(item);

      this.on(item, 'click', () => onMemberClick?.(member));
      list.appendChild(item);
    }

    wrapper.appendChild(list);

    return wrapper;
  }
}

export { icon } from '../ui/dom.js';