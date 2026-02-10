import 'package:shared_preferences/shared_preferences.dart';

class SessionStore {
  static const _kCookie = 'session_cookie';
  static const _kBaseUrl = 'server_base_url';

  Future<String?> loadCookie() async {
    final p = await SharedPreferences.getInstance();
    final v = p.getString(_kCookie);
    return (v == null || v.trim().isEmpty) ? null : v;
  }

  Future<void> saveCookie(String cookie) async {
    final p = await SharedPreferences.getInstance();
    await p.setString(_kCookie, cookie);
  }

  Future<String?> loadBaseUrl() async {
    final p = await SharedPreferences.getInstance();
    final v = p.getString(_kBaseUrl);
    return (v == null || v.trim().isEmpty) ? null : v.trim();
  }

  Future<void> saveBaseUrl(String baseUrl) async {
    final p = await SharedPreferences.getInstance();
    await p.setString(_kBaseUrl, baseUrl.trim());
  }

  Future<void> clear() async {
    final p = await SharedPreferences.getInstance();
    await p.remove(_kCookie);
  }
}
