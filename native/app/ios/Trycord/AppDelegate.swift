import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
import React_RCTLinking
import UserNotifications

@main
class AppDelegate: RCTAppDelegate {
  /// The presenter is held here so the notification centre keeps a strong
  /// reference to its delegate for the life of the app.
  private static let notificationPresenter = NotificationPresenter()

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    self.moduleName = "Trycord"
    self.dependencyProvider = RCTAppDependencyProvider()
    self.initialProps = [:]

    // Foreground notifications are shown by the presenter rather than by the
    // system, because the payload deliberately carries no text: the app
    // fetches the message itself once it is in front.
    UNUserNotificationCenter.current().delegate = AppDelegate.notificationPresenter

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }

  /// The trycord:// scheme arrives here, and is handed to the linking
  /// manager, which turns it into the event the JavaScript side listens for.
  override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return RCTLinkingManager.application(app, open: url, options: options)
  }

  /// A universal link: the same destination, reached from a browser.
  override func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    return RCTLinkingManager.application(
      application,
      continue: userActivity,
      restorationHandler: restorationHandler
    )
  }
}
