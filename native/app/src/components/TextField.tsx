import React from 'react';
import {
  KeyboardTypeOptions,
  StyleSheet,
  TextInput,
  TextInputProps,
  View,
} from 'react-native';

import {useTheme} from '../theme';
import {AppText} from './AppText';

export interface TextFieldProps {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  secureTextEntry?: boolean;
  keyboardType?: KeyboardTypeOptions;
  autoCapitalize?: TextInputProps['autoCapitalize'];
  autoComplete?: TextInputProps['autoComplete'];
  textContentType?: TextInputProps['textContentType'];
  inputMode?: TextInputProps['inputMode'];
  multiline?: boolean;
  numberOfLines?: number;
  error?: string | null;
  hint?: string;
  editable?: boolean;
  testID?: string;
  onSubmitEditing?: () => void;
  returnKeyType?: TextInputProps['returnKeyType'];
}

/**
 * A labelled field.
 *
 * The label is a real label: it is bound to the input, so a screen reader
 * announces what the field is for, and the error is announced too. The
 * placeholder is only a hint - it is not the label, and it disappears the
 * moment the field is used.
 */
export function TextField({
  label,
  value,
  onChangeText,
  placeholder,
  secureTextEntry,
  keyboardType,
  autoCapitalize,
  autoComplete,
  textContentType,
  inputMode,
  multiline,
  numberOfLines,
  error,
  hint,
  editable = true,
  testID,
  onSubmitEditing,
  returnKeyType,
}: TextFieldProps): React.JSX.Element {
  const theme = useTheme();

  return (
    <View style={styles.wrapper}>
      <AppText variant="label" tone="muted" style={styles.label}>
        {label}
      </AppText>
      <TextInput
        testID={testID}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.semantic.text3}
        secureTextEntry={secureTextEntry}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoComplete={autoComplete}
        textContentType={textContentType}
        inputMode={inputMode}
        multiline={multiline}
        numberOfLines={numberOfLines}
        editable={editable}
        onSubmitEditing={onSubmitEditing}
        returnKeyType={returnKeyType}
        accessibilityLabel={label}
        accessibilityHint={hint}
        maxFontSizeMultiplier={1.6}
        allowFontScaling
        style={[
          styles.input,
          {
            color: theme.semantic.text1,
            backgroundColor: theme.semantic.panel2,
            borderColor: error ? theme.semantic.danger : theme.semantic.line,
            borderRadius: theme.radii.md,
            paddingHorizontal: theme.spacing[3],
            fontSize: theme.typeScale.body,
            minHeight: multiline ? 96 : theme.minTouchTarget,
            textAlignVertical: multiline ? 'top' : 'center',
          },
        ]}
      />
      {error ? (
        <AppText
          variant="meta"
          tone="danger"
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={styles.note}>
          {error}
        </AppText>
      ) : hint ? (
        <AppText variant="meta" tone="faint" style={styles.note}>
          {hint}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    gap: 6,
  },
  label: {
    marginLeft: 2,
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
  },
  note: {
    marginLeft: 2,
  },
});
