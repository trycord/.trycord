/**
 * Trycord native client entry point.
 *
 * The application is registered under the name in app.json, which is also the
 * name the iOS bundle and the Android application id are derived from.
 */
import {AppRegistry} from 'react-native';

import App from './src/App';
import {name as appName} from './app.json';

AppRegistry.registerComponent(appName, () => App);
