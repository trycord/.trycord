// Conversation Browser Component
// Fetches and displays user conversations using existing backend API

import { el, mount, update, clear } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { State, on as onState } from '../../packages/store.js';
import { Events } from '../../packages/realtime.js';
import Api from '../../packages/api.js';
import { avatar, countBadge } from '../ui/primitives.js';
import { errorToast } from '../ui/overlays.js';
import { navigate } from '../../packages/nav.js';

export class ConversationBrowser {
  constructor() {
    this.container = null;
    this.list = null;
    this.emptyState = null;
    this.header = null;
    this.loading = false;
    this.conversations = [];
    this.selectedConversation = null;
    
    // Event listeners
    this.onConversationsUpdate = this.onConversationsUpdate.bind(this);
    this.onDmUpdate = this.onDmUpdate.bind(this);
    this.onDmInvite = this.onDmInviteUpdate.bind(this);
  }
  
  // Render the conversation browser UI
  render() {
    this.container = el('div', { class: 'conversation-browser' },
      this.header = el('div', { class: 'conversation-header' },
        el('h2', { class: 'conversation-title' }, 'Messages'),
        el('div', { class: 'conversation-actions' },
          el('button', { 
            class: 'btn btn--icon btn--quiet btn--sm', 
            type: 'button',
            'aria-label': 'Start a new conversation',
            onclick: () => this.showNewConversationDialog()
          },
            icon('plus', 'Start a new conversation'),
          ),
          el('button', { 
            class: 'btn btn--icon btn--quiet btn--sm', 
            type: 'button',
            'aria-label': 'Search conversations',
            onclick: () => this.searchConversations()
          },
            icon('search', 'Search conversations'),
          ),
        ),
      ),
      this.list = el('div', { class: 'conversation-list' }),
      this.emptyState = el('div', { class: 'conversation-empty', hidden: true },
        el('div', { class: 'conversation-empty-icon' }, icon('message-square', 'No conversations')),
        el('p', { class: 'conversation-empty-text' }, 'No direct messages yet'),
        el('p', { class: 'conversation-empty-subtext' }, 'Start a new conversation to begin messaging'),
        el('button', { 
          class: 'btn btn--primary btn--sm', 
          onclick: () => this.showNewConversationDialog()
        }, 'New conversation'),
      ),
    );
    
    this.attachEventListeners();
    return this.container;
  }
  
  // Attach event listeners
  attachEventListeners() {
    onState('dms', this.onConversationsUpdate);
    Events.on(Events.EVENTS.DM_CONVERSATION_UPDATED, this.onDmUpdate);
    Events.on(Events.EVENTS.DM_MESSAGE, this.onNewMessageUpdate);
    Events.on(Events.EVENTS.DM_MESSAGE_DELETED, this.onMessageDeletedUpdate);
    onState('dmInvites', this.onDmInvite);
  }
  
  // Fetch conversations from backend
  async fetchConversations() {
    if (this.loading) return;
    
    this.loading = true;
    try {
      const response = await Api.dms();
      this.conversations = Array.isArray(response) ? response : (response && response.items) || [];
      this.renderConversations();
    } catch (error) {
      console.error('Failed to fetch conversations:', error);
      this.showError('Failed to load conversations');
    } finally {
      this.loading = false;
    }
  }
  
  // Render conversation list
  renderConversations() {
    clear(this.list);
    
    if (!this.conversations.length) {
      this.emptyState.hidden = false;
      return;
    }
    
    this.emptyState.hidden = true;
    
    this.conversations.forEach(conversation => {
      const conversationEl = this.renderConversation(conversation);
      this.list.appendChild(conversationEl);
    });
  }
  
  // Render individual conversation item
  renderConversation(conversation) {
    const isActive = this.selectedConversation?.id === conversation.id;
    const hasUnread = conversation.unreadCount > 0;
    const peer = conversation.peer || conversation.people?.[0];
    
    const conversationEl = el('div', {
      class: `conversation-item ${isActive ? 'active' : ''} ${hasUnread ? 'unread' : ''}`
    },
      el('button', {
        class: 'conversation-item-button',
        onclick: () => this.selectConversation(conversation)
      },
        el('div', { class: 'conversation-avatar' },
          avatar(peer, { size: 32, online: peer?.presence === 'online' }),
        ),
        el('div', { class: 'conversation-content' },
          el('div', { class: 'conversation-header' },
            el('h3', { class: 'conversation-name' }, peer?.username || 'Unknown'),
            el('span', { class: 'conversation-time' }, this.formatTime(conversation.lastMessageAt)),
            hasUnread && el('span', { class: 'conversation-badge' }, conversation.unreadCount),
          ),
          el('div', { class: 'conversation-preview' },
            conversation.lastMessage && el('span', {
              class: `conversation-message ${conversation.lastMessage.senderId === State.user?.id ? 'sent' : 'received'}`
            }, this.truncateText(conversation.lastMessage.content || '', 50)),
            conversation.lastMessage?.type === 'system' && el('span', { class: 'conversation-system' }, 'System: ' + conversation.lastMessage.content),
          ),
        ),
      ),
    );
    
    return conversationEl;
  }
  
  // Select a conversation and open chat view
  selectConversation(conversation) {
    this.selectedConversation = conversation;
    this.renderConversations();
    
    // Emit event for main app to handle conversation selection
    Events.emit('conversation:selected', conversation);
    
    // Mark as read if unread
    if (conversation.unreadCount > 0) {
      this.markConversationAsRead(conversation.id);
    }
  }
  
  // Show new conversation dialog
  showNewConversationDialog() {
    // For now, just navigate to the find users page
    // In a complete implementation, this would show a modal
    navigate('/friends');
  }
  
  // Search conversations
  searchConversations() {
    // Implementation would open search interface
    console.log('Search conversations');
  }
  
  // Format timestamp for display
  formatTime(timestamp) {
    if (!timestamp) return '';
    
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    
    if (diff < 60000) { // Less than 1 minute
      return 'Now';
    } else if (diff < 3600000) { // Less than 1 hour
      return Math.floor(diff / 60000) + 'm';
    } else if (diff < 86400000) { // Less than 1 day
      return Math.floor(diff / 3600000) + 'h';
    } else if (diff < 604800000) { // Less than 1 week
      return Math.floor(diff / 86400000) + 'd';
    } else {
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
  }
  
  // Truncate text for preview
  truncateText(text, maxLength) {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
  }
  
  // Show error message
  showError(message) {
    console.error(message);
    // Show error toast if available
    if (typeof errorToast === 'function') {
      errorToast(message);
    }
  }
  
  // Event handlers
  onConversationsUpdate() {
    this.fetchConversations();
  }
  
  onDmUpdate(event) {
    // Refresh conversations when DM state changes
    this.fetchConversations();
  }
  
  onNewMessageUpdate(event) {
    // Update conversation list when new message arrives
    if (event.conversationId) {
      this.fetchConversations();
    }
  }
  
  onMessageDeletedUpdate(event) {
    // Refresh conversations when message is deleted
    this.fetchConversations();
  }
  
  onDmInviteUpdate() {
    // Refresh conversations when new DM invite arrives
    this.fetchConversations();
  }
  
  // Mark conversation as read
  async markConversationAsRead(conversationId) {
    try {
      await Api.dmRead(conversationId);
    } catch (error) {
      console.error('Failed to mark conversation as read:', error);
    }
  }
  
  // Cleanup event listeners
  destroy() {
    onState('dms', this.onConversationsUpdate);
    Events.on(Events.EVENTS.DM_CONVERSATION_UPDATED, this.onDmUpdate);
    Events.on(Events.EVENTS.DM_MESSAGE, this.onNewMessageUpdate);
    Events.on(Events.EVENTS.DM_MESSAGE_DELETED, this.onMessageDeletedUpdate);
    onState('dmInvites', this.onDmInvite);
  }
}

// Export for use in main app
export default ConversationBrowser;