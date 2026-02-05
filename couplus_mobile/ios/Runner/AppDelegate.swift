import Flutter
import UIKit
import UserNotifications

@main
@objc class AppDelegate: FlutterAppDelegate {
  private let channelName = "couplus/push"
  private var pushChannel: FlutterMethodChannel?

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    GeneratedPluginRegistrant.register(with: self)

    if let controller = window?.rootViewController as? FlutterViewController {
      let ch = FlutterMethodChannel(name: channelName, binaryMessenger: controller.binaryMessenger)
      pushChannel = ch
      ch.setMethodCallHandler({ [weak self] call, result in
        if call.method == "ensureRegistered" {
          self?.ensurePushRegistered(application)
          result(true)
        } else {
          result(FlutterMethodNotImplemented)
        }
      })
    }

    // Ask permission early (best-effort). Token will be sent to Flutter when available.
    ensurePushRegistered(application)

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  private func ensurePushRegistered(_ application: UIApplication) {
    UNUserNotificationCenter.current().delegate = self
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
      guard granted else { return }
      DispatchQueue.main.async {
        application.registerForRemoteNotifications()
      }
    }
  }

  override func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    let token = deviceToken.map { String(format: "%02.2hhx", $0) }.joined()
    pushChannel?.invokeMethod("apnsToken", arguments: token)
  }

  override func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
    pushChannel?.invokeMethod("apnsError", arguments: String(describing: error))
  }

  override func applicationDidBecomeActive(_ application: UIApplication) {
    // Retry registration when app becomes active (helps after first-time permission prompts)
    ensurePushRegistered(application)
  }
}
