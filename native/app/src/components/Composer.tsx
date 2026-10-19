import React from 'react';
import {StyleSheet, TextInput, View} from 'react-native';

import {useTheme} from '../theme';
import {AppText} from './AppText';
import {IconButton} from './Avatar';

export interface ComposerProps {
  value: string;
  onChangeText: (value: string) => void;
  onSend: () => void;
  placeholder?: string;
  busy?: boolean;
  /** Shown under the field, for example that a draft is saved. */
  note?: string | null;
  accessibilityLabel?: string;
}

/**
 * The composer.
 *
 * The field grows with what is written, up to a ceiling, and the send control
 * is a real button with a name. What is typed is saved as a draft by the
 * screen that owns this, so nothing is lost when the connection drops.
 */
export function Composer({
  value,
  onChangeText,
  onSend,
  placeholder = 'Message',
  busy = false,
  note,
  accessibilityLabel,
}: ComposerProps): React.JSX.Element {
  const theme = useTheme();

  return (
    <View
      style={[
        styles.base,
        {
          backgroundColor: theme.semantic.panel,
          borderTopColor: theme.semantic.line,
          paddingHorizontal: theme.spacing[3],
          paddingTop: theme.spacing[2],
          paddingBottom: theme.spacing[2],
          gap: theme.spacing[1],
        },
      ]}>
      {note ? (
        <AppText variant="micro" tone="faint" accessibilityLiveRegion="polite">
          {note}
        </AppText>
      ) : null}
      <View style={styles.row}>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={theme.semantic.text3}
          multiline
          accessibilityLabel={accessibilityLabel || placeholder}
          maxFontSizeMultiplier={1.6}
          allowFontScaling
          style={[
            styles.input,
            {
              color: theme.semantic.text1,
              backgroundColor: theme.semantic.panel2,
              borderColor: theme.semantic.line,
              borderRadius: theme.radii.lg,
              paddingHorizontal: theme.spacing[3],
              paddingTop: theme.spacing[2],
              paddingBottom: theme.spacing[2],
              fontSize: theme.typeScale.body,
              maxHeight: theme.composerMaxHeight,
            },
          ]}
        />
        <IconButton
          icon="send"
          label="Send"
          onPress={onSend}
          disabled={busy || !value.trim()}
          tint={theme.semantic.brand}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  input: {
    flex: 1,
    minHeight: 44,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
