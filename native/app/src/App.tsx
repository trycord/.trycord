/**
 * The application.
 *
 * The providers, the navigator, and the one piece of platform plumbing the
 * navigator cannot own: deep links. A link arrives from outside the app -
 * from another app, from a notification, from a browser - and it says where
 * to go. The handler waits until there is a session, because a link to a
 * channel cannot be opened by somebody who is not signed in.
 */

import React, {useCallback, useEffect, useState} from 'react';
import {ActivityIndicator, Linking, StyleSheet, View} from 'react-native';
import {
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
  Theme as NavigationTheme,
} from '@react-navigation/native';
import {SafeAreaProvider} from 'react-native-safe-area-context';

import {ApiClient} from './api/client';
import {endpoints} from './api';
import {AppText} from './components';
import {DeepLinkTarget, parseDeepLink} from './deepLinks';
import {navigationRef, navigate} from './navigation/navigationRef';
import {AppNavigator, AuthNavigator} from './navigation/RootNavigator';
import {SessionProvider, useSession} from './session/SessionProvider';
import {ThemeProvider, useTheme} from './theme';

export default function App(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <SessionProvider>
          <AppShell />
        </SessionProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function AppShell(): React.JSX.Element {
  const theme = useTheme();
  const {phase, api} = useSession();
  const [pendingLink, setPendingLink] = useState<DeepLinkTarget | null>(null);

  useEffect(() => {
    void Linking.getInitialURL().then(url => {
      if (!url) return;
      const target = parseDeepLink(url);
      if (target) setPendingLink(target);
    });
    const subscription = Linking.addEventListener('url', event => {
      const target = parseDeepLink(event.url);
      if (target) setPendingLink(target);
    });
    return () => subscription.remove();
  }, []);

  const openTarget = useCallback(
    async (target: DeepLinkTarget, client: ApiClient) => {
      switch (target.kind) {
        case 'community': {
          const community = await resolveCommunity(client, target.communityRef);
          if (!community) return;
          navigate('CommunityChannels', {
            serverId: community.id,
            title: community.name,
          });
          return;
        }
        case 'channel': {
          const community = await resolveCommunity(client, target.communityRef);
          if (!community) return;
          const tree = await endpoints.channelTree(client, community.id);
          const channel = tree.channels.find(entry => entry.id === target.channelId);
          navigate('Conversation', {
            kind: 'channel',
            targetId: target.channelId,
            serverId: community.id,
            title: channel ? channel.name : 'Channel',
            messageId: target.messageId,
          });
          return;
        }
        case 'dm': {
          const conversation = await endpoints.conversation(
            client,
            target.conversationId,
          );
          const peer = conversation?.peer;
          navigate('Conversation', {
            kind: 'dm',
            targetId: target.conversationId,
            title: peer?.displayName || peer?.username || 'Conversation',
            messageId: target.messageId,
          });
          return;
        }
        case 'profile': {
          navigate('Profile', {userId: target.userId});
          return;
        }
        case 'conversations': {
          navigate('Tabs', {screen: 'Conversations'});
          return;
        }
        case 'settings': {
          navigate('Tabs', {screen: 'Settings'});
          return;
        }
        default:
          // The instance chooser is on the signed-out side of the app, and a
          // reset link is handled before this.
          return;
      }
    },
    [],
  );

  useEffect(() => {
    if (!pendingLink) return;
    if (!navigationRef.isReady()) return;
    const target = pendingLink;

    // A reset link is used while signed out, so it is handled before the
    // session is required.
    if (target.kind === 'resetPassword') {
      setPendingLink(null);
      if (phase === 'signed-out') {
        navigate('ResetPassword', {token: target.token});
      }
      return;
    }

    if (phase !== 'signed-in') return;
    setPendingLink(null);
    void openTarget(target, api).catch(() => {
      // A link to something that is not there is not worth interrupting the
      // reader for; the screen they land on will say what is missing.
    });
  }, [api, openTarget, pendingLink, phase]);

  const navigationTheme = navigationThemeFor(theme);

  return (
    <NavigationContainer ref={navigationRef} theme={navigationTheme}>
      {phase === 'restoring' ? (
        <BootScreen />
      ) : phase === 'signed-in' ? (
        <AppNavigator />
      ) : (
        <AuthNavigator />
      )}
    </NavigationContainer>
  );
}

function BootScreen(): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={[styles.boot, {backgroundColor: theme.semantic.appBg}]}
      accessibilityRole="progressbar"
      accessibilityLabel="Starting">
      <AppText variant="title">Trycord</AppText>
      <ActivityIndicator color={theme.semantic.brand} />
    </View>
  );
}

function navigationThemeFor(theme: ReturnType<typeof useTheme>): NavigationTheme {
  const base = theme.isDark ? DarkTheme : DefaultTheme;
  return {
    ...base,
    dark: theme.isDark,
    colors: {
      ...base.colors,
      primary: theme.semantic.brand,
      background: theme.semantic.appBg,
      card: theme.semantic.panel,
      text: theme.semantic.text1,
      border: theme.semantic.line,
      notification: theme.semantic.brand,
    },
  };
}

/**
 * Finds the community a link names.
 *
 * A link may name a community by its identifier or by its slug, because both
 * are things a person can put in a link and only one of them is a name.
 */
async function resolveCommunity(
  client: ApiClient,
  reference: string,
): Promise<{id: string; name: string} | null> {
  const communities = await endpoints.communities(client);
  const found = communities.find(
    community =>
      community.id === reference ||
      (!!community.slug && community.slug === reference),
  );
  return found ? {id: found.id, name: found.name} : null;
}

const styles = StyleSheet.create({
  boot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
});
