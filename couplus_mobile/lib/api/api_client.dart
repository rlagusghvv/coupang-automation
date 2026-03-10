import 'dart:convert';

import 'package:couplus_mobile/api/session_store.dart';
import 'package:flutter/foundation.dart';
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
        _baseUrl = _normalizeBase(baseUrl ?? defaultBaseUrl),
        _sessionStore = sessionStore ?? SessionStore();

  static const List<String> _fallbackBaseUrls = <String>[
    'https://app.splui.com',
    'https://app2.splui.com',
  ];

  static String get defaultBaseUrl {
    // On web, start with current origin and fallback automatically.
    if (kIsWeb) {
      return Uri.base.origin;
    }
    // Native default (can be changed in More 탭)
    return 'https://app.splui.com';
  }

  final http.Client _client;
  String _baseUrl;
  final SessionStore _sessionStore;

  String get baseUrl => _baseUrl;

  String proxyImageUrl(String rawUrl) {
    var u = rawUrl.trim();
    if (u.isEmpty) return u;

    final parsed = Uri.tryParse(u);
    if (parsed != null && parsed.hasScheme) {
      final scheme = parsed.scheme.toLowerCase();
      if (scheme != 'http' && scheme != 'https') {
        return u;
      }
    }

    if (u.startsWith('vendor_inventory/')) {
      u = 'https://image.coupangcdn.com/image/$u';
    } else if (u.startsWith('/vendor_inventory/')) {
      u = 'https://image.coupangcdn.com/image$u';
    } else if (!(u.startsWith('http://') || u.startsWith('https://'))) {
      final rel = u.startsWith('/') ? u : '/$u';
      u = '$baseUrl$rel';
    }

    // Proxy some CDNs to avoid loading failures on some platforms (hotlink/CORS/etc).
    if (u.contains('domeggook.com') || u.contains('coupangcdn.com')) {
      return '$baseUrl/api/image-proxy?url=${Uri.encodeComponent(u)}';
    }
    return u;
  }

  String? _cookie; // e.g. "session=..."
  bool _loaded = false;

  static String _normalizeBase(String raw) {
    var v = raw.trim();
    while (v.endsWith('/')) {
      v = v.substring(0, v.length - 1);
    }
    return v;
  }

  bool _isSameOriginWeb(String base) {
    if (!kIsWeb) return true;
    try {
      return Uri.parse(base).origin == Uri.base.origin;
    } catch (_) {
      return false;
    }
  }

  Uri _uForBase(String base, String path, [Map<String, String>? query]) {
    final p = path.startsWith('/') ? path : '/$path';
    return Uri.parse(base).replace(path: p, queryParameters: query);
  }

  Future<void> init() async {
    if (_loaded) return;
    _cookie = await _sessionStore.loadCookie();
    final savedBaseUrl = await _sessionStore.loadBaseUrl();
    if (savedBaseUrl != null && savedBaseUrl.trim().isNotEmpty) {
      final saved = _normalizeBase(savedBaseUrl);
      if (!kIsWeb || _isSameOriginWeb(saved)) {
        _baseUrl = saved;
      } else {
        // Web must stay same-origin to avoid CORS/preflight failures.
        _baseUrl = Uri.base.origin;
        await _sessionStore.saveBaseUrl(_baseUrl);
      }
    }
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

  Future<void> setBaseUrl(String next) async {
    final v = _normalizeBase(next);
    if (v.isEmpty) return;
    if (kIsWeb && !_isSameOriginWeb(v)) {
      return;
    }
    _baseUrl = v;
    await _sessionStore.saveBaseUrl(v);
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

  bool _looksHtml(String body) {
    final t = body.trimLeft().toLowerCase();
    return t.startsWith('<!doctype html') || t.startsWith('<html');
  }

  List<String> _candidateBaseUrls() {
    final out = <String>[];
    final seen = <String>{};

    void add(String? raw) {
      final v = _normalizeBase(raw ?? '');
      if (v.isEmpty) return;
      if (seen.add(v)) out.add(v);
    }

    if (kIsWeb) {
      add(Uri.base.origin);
      if (_isSameOriginWeb(_baseUrl)) add(_baseUrl);
      return out;
    }

    add(_baseUrl);
    for (final b in _fallbackBaseUrls) {
      add(b);
    }
    return out;
  }

  bool _shouldRetryWithFallback(http.Response res) {
    final code = res.statusCode;
    if (code == 404 || code == 502 || code == 503 || code == 504) return true;
    if (_looksHtml(res.body)) return true;
    return false;
  }

  Future<void> _rememberBaseIfChanged(String nextBase) async {
    final v = _normalizeBase(nextBase);
    if (kIsWeb && !_isSameOriginWeb(v)) return;
    if (v == _baseUrl) return;
    _baseUrl = v;
    await _sessionStore.saveBaseUrl(v);
  }

  Future<http.Response> _requestWithFallback({
    required String method,
    required String path,
    Map<String, String>? query,
    Map<String, String>? headers,
    Object? body,
  }) async {
    final bases = _candidateBaseUrls();
    Object? lastError;

    for (var i = 0; i < bases.length; i += 1) {
      final base = bases[i];
      final uri = _uForBase(base, path, query);
      try {
        late http.Response res;
        if (method == 'GET') {
          res = await _client.get(uri, headers: headers);
        } else if (method == 'POST') {
          res = await _client.post(uri, headers: headers, body: body);
        } else if (method == 'DELETE') {
          res = await _client.delete(uri, headers: headers);
        } else {
          throw StateError('unsupported method: $method');
        }

        _captureSetCookie(res);

        final hasNext = i < bases.length - 1;
        if (_shouldRetryWithFallback(res) && hasNext) {
          continue;
        }

        if (res.statusCode < 400 && !_looksHtml(res.body)) {
          await _rememberBaseIfChanged(base);
        }

        return res;
      } catch (e) {
        lastError = e;
        final hasNext = i < bases.length - 1;
        if (!hasNext) rethrow;
      }
    }

    throw lastError ?? StateError('request failed');
  }

  Future<Map<String, dynamic>> getJson(String path,
      {Map<String, String>? query}) async {
    await init();
    final res = await _requestWithFallback(
      method: 'GET',
      path: path,
      query: query,
      headers: _headers(),
    );

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

  Future<Map<String, dynamic>> postJson(
      String path, Map<String, dynamic> body) async {
    await init();
    final res = await _requestWithFallback(
      method: 'POST',
      path: path,
      headers: _headers(extra: {'Content-Type': 'application/json'}),
      body: jsonEncode(body),
    );

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

  Future<Map<String, dynamic>> postBytesJson(
    String path,
    List<int> bytes, {
    Map<String, String>? query,
    String contentType = 'application/octet-stream',
    Map<String, String>? extraHeaders,
  }) async {
    await init();
    final headers = _headers(
      extra: <String, String>{
        'Content-Type': contentType,
        if (extraHeaders != null) ...extraHeaders,
      },
    );
    final res = await _requestWithFallback(
      method: 'POST',
      path: path,
      query: query,
      headers: headers,
      body: bytes,
    );

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

  Future<Map<String, dynamic>> deleteJson(String path) async {
    await init();
    final res = await _requestWithFallback(
      method: 'DELETE',
      path: path,
      headers: _headers(),
    );

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
