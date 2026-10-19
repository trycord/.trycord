import React from 'react';
import {StyleSheet, View} from 'react-native';

import {RealtimeStatus} from '../realtime/socket';
import {useTheme} from '../theme';
import {AppText} from './AppText';
import {Icon} from './Icon';

export interface ConnectionBannerProps {
  status: RealtimeStatus;
}

/**
 * Says whether the live connection is up.
 *
 * It is a live region, so the change is announced rather than only drawn,
 * and it says what is happening: "Connecting", "Live", or "Offline - messages
 * will send when the connection returns".
 */
export function ConnectionBanner({status}: ConnectionBannerProps): React.JSX.Element | null {
  const theme = useTheme();
  if (status === 'online') return null;

  const offline = status === 'offline';
  const tint = offline ? theme.semantic.warning : theme.semantic.text2;

  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      style={[
        styles.base,
        {
          backgroundColor: theme.semantic.panel2,
          paddingHorizontal: theme.spacing[4],
          paddingVertical: theme.spacing[2],
        },
      ]}>
      <Icon name={offline ? 'wifi-off' : 'loader'} size={16} color={tint} />
      <AppText variant="meta" tone={offline ? 'primary' : 'muted'}>
        {offline
          ? 'Offline. Messages will send when the connection returns.'
          : 'Connecting…'}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
});
