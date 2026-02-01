import 'dart:convert';

import 'package:http/http.dart' as http;

class ApiClient {
  ApiClient({http.Client? client, String? baseUrl})
      : _client = client ?? http.Client(),
        baseUrl = baseUrl ?? defaultBaseUrl;

  static const String defaultBaseUrl = 'http://macmini.tail4fbf54.ts.net:3000';

  final http.Client _client;
  final String baseUrl;

  Uri _u(String path, [Map<String, String>? query]) {
    final p = path.startsWith('/') ? path : '/$path';
    return Uri.parse(baseUrl).replace(path: p, queryParameters: query);
  }

  Future<Map<String, dynamic>> getJson(String path,
      {Map<String, String>? query}) async {
    final res = await _client.get(_u(path, query));
    final body = res.body;

    Map<String, dynamic> json;
    try {
      json = jsonDecode(body) as Map<String, dynamic>;
    } catch (_) {
      throw Exception('Invalid JSON (${res.statusCode}): $body');
    }

    if (res.statusCode >= 400) {
      throw Exception('HTTP ${res.statusCode}: ${json['error'] ?? body}');
    }

    return json;
  }
}
