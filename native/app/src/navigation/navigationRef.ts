import {createNavigationContainerRef} from '@react-navigation/native';

import {RootParamList} from './types';

/**
 * A reference to the navigator, for the one place that cannot use a prop: the
 * deep-link handler, which runs outside the tree.
 */
export const navigationRef = createNavigationContainerRef<RootParamList>();

export function navigate(name: keyof RootParamList, params?: unknown): void {
  if (navigationRef.isReady()) {
    navigationRef.navigate(name as never, params as never);
  }
}

export function resetTo(name: keyof RootParamList, params?: unknown): void {
  if (navigationRef.isReady()) {
    navigationRef.reset({
      index: 0,
      routes: [{name: name as never, params: params as never}],
    });
  }
}
