/**
 * The routes.
 *
 * The addresses the application can be at. They are the product's addresses
 * rather than the module's: a community, a channel, a conversation, a
 * person, a page of settings.
 */

export type AuthStackParamList = {
  SignIn: {instanceUrl?: string} | undefined;
  Register: {instanceUrl?: string} | undefined;
  ForgotPassword: {instanceUrl?: string} | undefined;
  ResetPassword: {token: string; instanceUrl?: string};
  TwoFactor: {
    mode: 'challenge' | 'enrol';
    challengeToken?: string;
    expiresInSeconds?: number;
    username?: string;
    instanceUrl?: string;
  };
  InstancePicker: undefined;
};

export type TabParamList = {
  Conversations: undefined;
  Communities: undefined;
  Settings: undefined;
};

export type AppStackParamList = {
  Tabs: undefined;
  Conversation: {
    kind: 'channel' | 'dm';
    targetId: string;
    serverId?: string;
    title: string;
    messageId?: string;
  };
  CommunityChannels: {serverId: string; title: string};
  MemberList: {serverId: string; title: string};
  Profile: {userId: string; title?: string};
  AccountSettings: undefined;
  SecuritySettings: undefined;
  NotificationSettings: undefined;
  PrivacySettings: undefined;
};

export type RootParamList = AuthStackParamList & AppStackParamList;
