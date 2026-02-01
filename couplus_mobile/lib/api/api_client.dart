import 'dart:convert';

import 'package:couplus_mobile/api/session_store.dart';
import 'package:http/http.dart' as http;

class ApiException implements Exception {
  ApiException({
    required this.statusCode,
    required this.message,
    this.details,
  });

  final int statusCode;
  final String message;
  final String? details;

  bool get isUnauthorized => statusCode == 401;

  @override
  String toString() {
    final d = (details == null || details!.isEmpty) ? '' : '\n$details';
    return 'HTTP $statusCode: $message$d';
  }
}

class ApiClient {
  ApiClient({http.Client? client, String? baseUrl, SessionStore? sessionStore})
      : _client = client ?? http.Client(),
        baseUrl = baseUrl ?? defaultBaseUrl,
        _sessionStore = sessionStore ?? SessionStore();

  static const String defaultBaseUrl = 'http://macmini.tail4fbf54.ts.net:3000';

  final http.Client _client;
  final String baseUrl;
  final SessionStore _sessionStore;

  String? _cookie; // e.g. "session=..."
  bool _loaded = false;

  Uri _u(String path, [Map<String, String>? query]) {
    final p = path.startsWith('/') ? path : '/$path';
    return Uri.parse(baseUrl).replace(path: p, queryParameters: query);
  }

  Future<void> init() async {
    if (_loaded) return;
    _cookie = await _sessionStore.loadCookie();
    _loaded = true;
  }

  String? get cookie => _cookie;

  Future<void> setCookie(String cookie) async {
    _cookie = cookie;
    _loaded = true;
    await _sessionStore.saveCookie(cookie);
  }

  Future<void> clearCookie() async {
    _cookie = null;
    _loaded = true;
    await _sessionStore.clear();
  }

  Map<String, String> _headers({Map<String, String>? extra}) {
    final h = <String, String>{
      'Accept': 'application/json',
    };
    if (_cookie != null && _cookie!.trim().isNotEmpty) {
      h['Cookie'] = _cookie!;
    }
    if (extra != null) h.addAll(extra);
    return h;
  }

  void _captureSetCookie(http.Response res) {
    final raw = res.headers['set-cookie'];
    if (raw == null || raw.isEmpty) return;

    // We only need "session=..." part.
    // Example: session=TOKEN; HttpOnly; Path=/; SameSite=Lax
    final m = RegExp(r'(^|;\s*)(session=[^;]+)').firstMatch(raw);
    final next = m?.group(2);
    if (next != null && next.trim().isNotEmpty) {
      _cookie = next;
      _sessionStore.saveCookie(next);
    }
  }

  Future<Map<String, dynamic>> getJson(String path, {Map<String, String>? query}) async {
    await init();
    final res = await _client.get(_u(path, query), headers: _headers());
    _captureSetCookie(res);

    final body = res.body;

    Map<String, dynamic> json;
    try {
      json = jsonDecode(body) as Map<String, dynamic>;
    } catch (_) {
      throw ApiException(
        statusCode: res.statusCode,
        message: 'Invalid JSON',
        details: body,
      );
    }

    if (res.statusCode >= 400) {
      throw ApiException(
        statusCode: res.statusCode,
        message: (json['error'] ?? 'request_failed').toString(),
        details: body,
      );
    }

    return json;
  }

  Future<Map<String, dynamic>> postJson(String path, Map<String, dynamic> body) async {
    await init();
    final res = await _client.post(
      _u(path),
      headers: _headers(extra: {'Content-Type': 'application/json'}),
      body: jsonEncode(body),
    );
    _captureSetCookie(res);

    final raw = res.body;
    Map<String, dynamic> json;
    try {
      json = jsonDecode(raw) as Map<String, dynamic>;
    } catch (_) {
      throw ApiException(
        statusCode: res.statusCode,
        message: 'Invalid JSON',
        details: raw,
      );
    }

    if (res.statusCode >= 400) {
      throw ApiException(
        statusCode: res.statusCode,
        message: (json['error'] ?? 'request_failed').toString(),
        details: raw,
      );
    }

    return json;
  }
}
