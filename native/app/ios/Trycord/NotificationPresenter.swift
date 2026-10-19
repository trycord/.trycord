import Foundation
import UserNotifications

/// Shows a notification that arrives while the app is in front.
///
/// The payload carries no message text on purpose, so the banner says what
/// kind of thing happened and nothing more. The message is fetched from the
/// server when the reader opens it.
final class NotificationPresenter: NSObject, UNUserNotificationCenterDelegate {
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .sound])
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    // The payload is read by the JavaScript side, which opens the right
    // place. Nothing is done here beyond letting the app know.
    completionHandler()
  }
}
