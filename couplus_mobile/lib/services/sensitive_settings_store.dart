import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Stores sensitive settings on-device.
///
/// Primary: iOS Keychain / Android Keystore via [FlutterSecureStorage].
/// Fallback: [SharedPreferences] if secure storage is unavailable.
class SensitiveSettingsStore {
  SensitiveSettingsStore({FlutterSecureStorage? secureStorage})
      : _secure = secureStorage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _secure;

  static const _kPrefix = 'sensitive.';

  // Keys mirror server/user settings keys.
  static const coupangAccessKey = 'coupangAccessKey';
  static const coupangSecretKey = 'coupangSecretKey';
  static const coupangVendorId = 'coupangVendorId';
  static const coupangVendorUserId = 'coupangVendorUserId';
  static const coupangDeliveryCompanyCode = 'coupangDeliveryCompanyCode';
  static const pagesApiToken = 'pagesApiToken';

  static const allKeys = <String>[
    coupangAccessKey,
    coupangSecretKey,
    coupangVendorId,
    coupangVendorUserId,
    coupangDeliveryCompanyCode,
    pagesApiToken,
  ];

  String _k(String key) => '$_kPrefix$key';

  Future<String?> read(String key) async {
    // Try secure storage first.
    try {
      final v = await _secure.read(key: _k(key));
      if (v != null) return v;
    } catch (_) {
      // ignore -> fallback
    }

    // Fallback.
    final p = await SharedPreferences.getInstance();
    return p.getString(_k(key));
  }

  Future<void> write(String key, String value) async {
    // Prefer secure storage.
    try {
      await _secure.write(key: _k(key), value: value);
      return;
    } catch (_) {
      // ignore -> fallback
    }

    final p = await SharedPreferences.getInstance();
    await p.setString(_k(key), value);
  }

  Future<void> delete(String key) async {
    try {
      await _secure.delete(key: _k(key));
    } catch (_) {
      // ignore
    }

    final p = await SharedPreferences.getInstance();
    await p.remove(_k(key));
  }

  Future<Map<String, String>> readAll() async {
    final out = <String, String>{};
    for (final k in allKeys) {
      final v = await read(k);
      if (v != null) out[k] = v;
    }
    return out;
  }
}
