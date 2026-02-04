import 'dart:async';
import 'package:flutter/services.dart';
import 'package:couplus_mobile/api/api_client.dart';

/// Receives APNs device token from native (iOS) and registers it to the server.
class PushTokenService {
  PushTokenService._();

  static final PushTokenService instance = PushTokenService._();

  static const MethodChannel _ch = MethodChannel('couplus/push');

  ApiClient? _api;
  String? _pendingToken;
  bool _bound = false;

  void bind(ApiClient api) {
    _api = api;
    if (_bound) {
      _tryRegister();
      return;
    }
    _bound = true;

    _ch.setMethodCallHandler((call) async {
      if (call.method == 'apnsToken') {
        final token = (call.arguments ?? '').toString().trim();
        if (token.isNotEmpty) {
          _pendingToken = token;
          _tryRegister();
        }
      }
    });

    // Ask native side to request permission + register.
    unawaited(_ch.invokeMethod('ensureRegistered'));

    _tryRegister();
  }

  Future<void> _tryRegister() async {
    final api = _api;
    final token = _pendingToken;
    if (api == null || token == null || token.isEmpty) return;

    // Must be logged in (cookie exists).
    if (api.cookie == null || api.cookie!.isEmpty) return;

    try {
      await api.postJson('/api/apns/register', {
        'deviceToken': token,
      });
    } catch (_) {
      // ignore (will retry on next bind/call)
      return;
    }
  }
}
