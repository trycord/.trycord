import React from 'react';
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {createNativeStackNavigator} from '@react-navigation/native-stack';

import {Icon} from '../components';
import {AppStackParamList, AuthStackParamList, TabParamList} from './types';
import {AccountSettingsScreen} from '../screens/AccountSettingsScreen';
import {CommunitiesScreen} from '../screens/CommunitiesScreen';
import {CommunityChannelsScreen} from '../screens/CommunityChannelsScreen';
import {ConversationScreen} from '../screens/ConversationScreen';
import {ConversationsScreen} from '../screens/ConversationsScreen';
import {ForgotPasswordScreen} from '../screens/ForgotPasswordScreen';
import {InstancePickerScreen} from '../screens/InstancePickerScreen';
import {MemberListScreen} from '../screens/MemberListScreen';
import {NotificationSettingsScreen} from '../screens/NotificationSettingsScreen';
import {PrivacySettingsScreen} from '../screens/PrivacySettingsScreen';
import {ProfileScreen} from '../screens/ProfileScreen';
import {RegisterScreen} from '../screens/RegisterScreen';
import {ResetPasswordScreen} from '../screens/ResetPasswordScreen';
import {SecuritySettingsScreen} from '../screens/SecuritySettingsScreen';
import {SettingsScreen} from '../screens/SettingsScreen';
import {SignInScreen} from '../screens/SignInScreen';
import {TwoFactorScreen} from '../screens/TwoFactorScreen';
import {useTheme} from '../theme';

const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const AppStack = createNativeStackNavigator<AppStackParamList>();
const TabStack = createBottomTabNavigator<TabParamList>();

/**
 * The screens a person who is not signed in sees.
 *
 * They are the whole page rather than screens inside the app, because a
 * person who is not signed in has no app to be inside.
 */
export function AuthNavigator(): React.JSX.Element {
  const theme = useTheme();
  return (
    <AuthStack.Navigator
      screenOptions={{
        headerShown: false,
        contentStyle: {backgroundColor: theme.semantic.appBg},
      }}>
      <AuthStack.Screen name="SignIn" component={SignInScreen} />
      <AuthStack.Screen name="Register" component={RegisterScreen} />
      <AuthStack.Screen name="ForgotPassword" component={ForgotPasswordScreen} />
      <AuthStack.Screen name="ResetPassword" component={ResetPasswordScreen} />
      <AuthStack.Screen name="TwoFactor" component={TwoFactorScreen} />
      <AuthStack.Screen name="InstancePicker" component={InstancePickerScreen} />
    </AuthStack.Navigator>
  );
}

function Tabs(): React.JSX.Element {
  const theme = useTheme();
  return (
    <TabStack.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.semantic.brand,
        tabBarInactiveTintColor: theme.semantic.text3,
        tabBarStyle: {
          backgroundColor: theme.semantic.panel,
          borderTopColor: theme.semantic.line,
        },
        tabBarLabelStyle: {
          fontSize: theme.typeScale.micro,
        },
      }}>
      <TabStack.Screen
        name="Conversations"
        component={ConversationsScreen}
        options={{
          title: 'Chats',
          tabBarIcon: ({color, size}) => (
            <Icon name="message" size={size} color={color} />
          ),
        }}
      />
      <TabStack.Screen
        name="Communities"
        component={CommunitiesScreen}
        options={{
          title: 'Communities',
          tabBarIcon: ({color, size}) => (
            <Icon name="server" size={size} color={color} />
          ),
        }}
      />
      <TabStack.Screen
        name="Settings"
        component={SettingsScreen}
        options={{
          title: 'Settings',
          tabBarIcon: ({color, size}) => (
            <Icon name="settings" size={size} color={color} />
          ),
        }}
      />
    </TabStack.Navigator>
  );
}

/**
 * The screens a person who is signed in sees.
 */
export function AppNavigator(): React.JSX.Element {
  const theme = useTheme();
  return (
    <AppStack.Navigator
      screenOptions={{
        headerStyle: {backgroundColor: theme.semantic.panel},
        headerTintColor: theme.semantic.text1,
        headerTitleStyle: {fontWeight: theme.fontWeights.strong},
        headerShadowVisible: false,
        contentStyle: {backgroundColor: theme.semantic.appBg},
      }}>
      <AppStack.Screen
        name="Tabs"
        component={Tabs}
        options={{headerShown: false}}
      />
      <AppStack.Screen
        name="Conversation"
        component={ConversationScreen}
        options={({route}) => ({title: route.params.title})}
      />
      <AppStack.Screen
        name="CommunityChannels"
        component={CommunityChannelsScreen}
        options={({route}) => ({title: route.params.title})}
      />
      <AppStack.Screen
        name="MemberList"
        component={MemberListScreen}
        options={{title: 'Members'}}
      />
      <AppStack.Screen
        name="Profile"
        component={ProfileScreen}
        options={({route}) => ({title: route.params.title || 'Profile'})}
      />
      <AppStack.Screen
        name="AccountSettings"
        component={AccountSettingsScreen}
        options={{title: 'Account'}}
      />
      <AppStack.Screen
        name="SecuritySettings"
        component={SecuritySettingsScreen}
        options={{title: 'Security'}}
      />
      <AppStack.Screen
        name="NotificationSettings"
        component={NotificationSettingsScreen}
        options={{title: 'Notifications'}}
      />
      <AppStack.Screen
        name="PrivacySettings"
        component={PrivacySettingsScreen}
        options={{title: 'Privacy'}}
      />
    </AppStack.Navigator>
  );
}
