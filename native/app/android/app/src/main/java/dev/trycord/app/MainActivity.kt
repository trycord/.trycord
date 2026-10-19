package dev.trycord.app

import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  /**
   * The name of the application, which is the name in app.json. It is the
   * same name the iOS bundle uses.
   */
  override fun getMainComponentName(): String = "Trycord"

  override fun onCreate(savedInstanceState: Bundle?) {
    // A null saved state is passed on: React Native restores its own.
    super.onCreate(null)
  }

  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
