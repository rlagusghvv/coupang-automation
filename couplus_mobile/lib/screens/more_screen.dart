import 'package:couplus_mobile/api/api_client.dart';

import 'package:couplus_mobile/screens/auth/webview_screen.dart';
import 'package:couplus_mobile/services/sensitive_settings_store.dart';
import 'package:couplus_mobile/ui/widgets.dart';
import 'package:flutter/material.dart';

class MoreScreen extends StatefulWidget {
  const MoreScreen({super.key, required this.api});

  final ApiClient api;

  @override
  State<MoreScreen> createState() => _MoreScreenState();
}

class _MoreScreenState extends State<MoreScreen> {
  final _email = TextEditingController();
  final _pw = TextEditingController();

  final _sensitiveStore = SensitiveSettingsStore();
  final _coupangAccessKey = TextEditingController();
  final _coupangSecretKey = TextEditingController();
  final _coupangVendorId = TextEditingController();
  final _coupangVendorUserId = TextEditingController();
  final _coupangDeliveryCompanyCode = TextEditingController();
  final _pagesApiToken = TextEditingController();

  bool _loading = false;
  bool _savingSensitive = false;
  bool _sensitiveUnlocked = false;
  bool _revealCoupangAccessKey = false;
  bool _revealCoupangSecretKey = false;
  bool _revealCoupangVendorId = false;
  bool _revealCoupangVendorUserId = false;
  bool _revealCoupangDeliveryCompanyCode = false;
  bool _revealPagesApiToken = false;

  String? _error;
  String? _sensitiveError;
  Map<String, dynamic>? _me;

  @override
  void initState() {
    super.initState();
    _loadSensitiveLocal();
    _refreshMe();
  }

  @override
  void dispose() {
    _email.dispose();
    _pw.dispose();
    _coupangAccessKey.dispose();
    _coupangSecretKey.dispose();
    _coupangVendorId.dispose();
    _coupangVendorUserId.dispose();
    _coupangDeliveryCompanyCode.dispose();
    _pagesApiToken.dispose();
    super.dispose();
  }

  Future<void> _refreshMe() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final json = await widget.api.getJson('/api/me');
      setState(() => _me = json);
      await _refreshSettings();
    } catch (e) {
      // 401은 에러 배너 대신 "로그인 필요" 상태로 처리
      if (e is ApiException && e.isUnauthorized) {
        setState(() {
          _me = null;
          // settings are loaded lazily after sign-in
          _error = null;
        });
      } else {
        setState(() {
          _me = null;
          _error = e.toString();
        });
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _loadSensitiveLocal() async {
    try {
      final local = await _sensitiveStore.readAll();
      // Don't setState for every key.
      _coupangAccessKey.text = local[SensitiveSettingsStore.coupangAccessKey] ??
          _coupangAccessKey.text;
      _coupangSecretKey.text = local[SensitiveSettingsStore.coupangSecretKey] ??
          _coupangSecretKey.text;
      _coupangVendorId.text = local[SensitiveSettingsStore.coupangVendorId] ??
          _coupangVendorId.text;
      _coupangVendorUserId.text =
          local[SensitiveSettingsStore.coupangVendorUserId] ??
              _coupangVendorUserId.text;
      _coupangDeliveryCompanyCode.text =
          local[SensitiveSettingsStore.coupangDeliveryCompanyCode] ??
              _coupangDeliveryCompanyCode.text;
      _pagesApiToken.text =
          local[SensitiveSettingsStore.pagesApiToken] ?? _pagesApiToken.text;
      if (mounted) setState(() {});
    } catch (e) {
      // Non-fatal.
      if (mounted) setState(() => _sensitiveError = e.toString());
    }
  }

  Future<void> _refreshSettings() async {
    try {
      final json = await widget.api.getJson('/api/settings');
      final s = (json['settings'] as Map?)?.cast<String, dynamic>() ??
          <String, dynamic>{};
      // keep local cache in text controllers

      // Pre-fill from server only if local is empty.
      _coupangAccessKey.text = _coupangAccessKey.text.isNotEmpty
          ? _coupangAccessKey.text
          : (s[SensitiveSettingsStore.coupangAccessKey]?.toString() ?? '');
      _coupangSecretKey.text = _coupangSecretKey.text.isNotEmpty
          ? _coupangSecretKey.text
          : (s[SensitiveSettingsStore.coupangSecretKey]?.toString() ?? '');
      _coupangVendorId.text = _coupangVendorId.text.isNotEmpty
          ? _coupangVendorId.text
          : (s[SensitiveSettingsStore.coupangVendorId]?.toString() ?? '');
      _coupangVendorUserId.text = _coupangVendorUserId.text.isNotEmpty
          ? _coupangVendorUserId.text
          : (s[SensitiveSettingsStore.coupangVendorUserId]?.toString() ?? '');
      _coupangDeliveryCompanyCode.text = _coupangDeliveryCompanyCode
              .text.isNotEmpty
          ? _coupangDeliveryCompanyCode.text
          : (s[SensitiveSettingsStore.coupangDeliveryCompanyCode]?.toString() ??
              '');
      _pagesApiToken.text = _pagesApiToken.text.isNotEmpty
          ? _pagesApiToken.text
          : (s[SensitiveSettingsStore.pagesApiToken]?.toString() ?? '');
    } catch (e) {
      // 401이면 로그인 상태로 자연스럽게 유도.
      if (e is ApiException && e.isUnauthorized) return;
      if (mounted) setState(() => _sensitiveError = e.toString());
    }
  }

  Future<void> _saveSensitive() async {
    if (!_sensitiveUnlocked) return;

    setState(() {
      _savingSensitive = true;
      _sensitiveError = null;
    });

    try {
      final accessKey = _coupangAccessKey.text.trim();
      final secretKey = _coupangSecretKey.text.trim();
      final vendorId = _coupangVendorId.text.trim();
      final vendorUserId = _coupangVendorUserId.text.trim();
      final deliveryCompanyCode = _coupangDeliveryCompanyCode.text.trim();
      final pagesToken = _pagesApiToken.text.trim();

      // Save on-device first.
      await _sensitiveStore.write(
          SensitiveSettingsStore.coupangAccessKey, accessKey);
      await _sensitiveStore.write(
          SensitiveSettingsStore.coupangSecretKey, secretKey);
      await _sensitiveStore.write(
          SensitiveSettingsStore.coupangVendorId, vendorId);
      await _sensitiveStore.write(
          SensitiveSettingsStore.coupangVendorUserId, vendorUserId);
      await _sensitiveStore.write(
          SensitiveSettingsStore.coupangDeliveryCompanyCode,
          deliveryCompanyCode);
      await _sensitiveStore.write(
          SensitiveSettingsStore.pagesApiToken, pagesToken);

      // Sync to server (requires auth cookie).
      await widget.api.postJson('/api/settings', {
        SensitiveSettingsStore.coupangAccessKey: accessKey,
        SensitiveSettingsStore.coupangSecretKey: secretKey,
        SensitiveSettingsStore.coupangVendorId: vendorId,
        SensitiveSettingsStore.coupangVendorUserId: vendorUserId,
        SensitiveSettingsStore.coupangDeliveryCompanyCode: deliveryCompanyCode,
        SensitiveSettingsStore.pagesApiToken: pagesToken,
      });

      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('Saved')));
      }
      await _refreshSettings();
    } catch (e) {
      if (mounted) setState(() => _sensitiveError = e.toString());
    } finally {
      if (mounted) setState(() => _savingSensitive = false);
    }
  }

  Future<void> _login() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      await widget.api.postJson('/api/login', {
        'email': _email.text.trim(),
        'password': _pw.text.trim(),
      });
      await _refreshMe();
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _signup() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      await widget.api.postJson('/api/signup', {
        'email': _email.text.trim(),
        'password': _pw.text.trim(),
      });
      await _refreshMe();
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _logout() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      await widget.api.postJson('/api/logout', {});
      await widget.api.clearCookie();
      await _refreshMe();
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final authedEmail = (_me?['user'] as Map?)?['email']?.toString() ?? '';

    return AppScaffold(
      title: 'More',
      onRefresh: _refreshMe,
      actions: [
        IconButton(
            onPressed: _loading ? null : _refreshMe,
            icon: const Icon(Icons.refresh)),
      ],
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (_error != null) ...[
            ErrorBanner(message: _error!, onRetry: _refreshMe),
            const SizedBox(height: 12),
          ],
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SectionHeader('Account',
                    trailing: _loading
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2))
                        : null),
                const SizedBox(height: 10),
                KvRow(
                    k: 'Session cookie',
                    v: widget.api.cookie == null ? '-' : 'Saved'),
                KvRow(k: 'Signed in', v: authedEmail.isEmpty ? 'No' : 'Yes'),
                if (authedEmail.isNotEmpty) KvRow(k: 'Email', v: authedEmail),
                const Divider(height: 24),
                TextField(
                  controller: _email,
                  keyboardType: TextInputType.emailAddress,
                  decoration: const InputDecoration(labelText: 'Email'),
                ),
                const SizedBox(height: 10),
                TextField(
                  controller: _pw,
                  obscureText: true,
                  decoration: const InputDecoration(labelText: 'Password'),
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: FilledButton(
                        onPressed: _loading ? null : _login,
                        child: const Text('Login'),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: OutlinedButton(
                        onPressed: _loading ? null : _signup,
                        child: const Text('Sign up'),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                SizedBox(
                  width: double.infinity,
                  child: TextButton(
                    onPressed: _loading ? null : _logout,
                    child: const Text('Logout'),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SectionHeader(
                  'Sensitive settings',
                  trailing: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (_sensitiveUnlocked)
                        TextButton(
                          onPressed: _savingSensitive
                              ? null
                              : () {
                                  setState(() {
                                    _sensitiveUnlocked = false;
                                    _revealCoupangAccessKey = false;
                                    _revealCoupangSecretKey = false;
                                    _revealCoupangVendorId = false;
                                    _revealCoupangVendorUserId = false;
                                    _revealCoupangDeliveryCompanyCode = false;
                                    _revealPagesApiToken = false;
                                  });
                                },
                          child: const Text('Lock'),
                        )
                      else
                        FilledButton.tonal(
                          onPressed: () async {
                            final ok = await showDialog<bool>(
                              context: context,
                              builder: (ctx) {
                                return AlertDialog(
                                  title:
                                      const Text('Unlock sensitive settings?'),
                                  content: const Text(
                                      'This will reveal API keys on screen. Only do this in a safe place.'),
                                  actions: [
                                    TextButton(
                                        onPressed: () =>
                                            Navigator.of(ctx).pop(false),
                                        child: const Text('Cancel')),
                                    FilledButton(
                                        onPressed: () =>
                                            Navigator.of(ctx).pop(true),
                                        child: const Text('Unlock')),
                                  ],
                                );
                              },
                            );
                            if (ok == true && mounted) {
                              setState(() => _sensitiveUnlocked = true);
                            }
                          },
                          child: const Text('Unlock'),
                        ),
                    ],
                  ),
                ),
                const SizedBox(height: 10),
                if (_sensitiveError != null) ...[
                  ErrorBanner(
                      message: _sensitiveError!, onRetry: _refreshSettings),
                  const SizedBox(height: 12),
                ],
                Text(
                  'Stored on this device (Keychain/Keystore) and synced to the server settings when you press Save.',
                  style: TextStyle(
                      fontSize: 12,
                      color: Theme.of(context)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: 0.60)),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _coupangAccessKey,
                  enabled: _sensitiveUnlocked && !_savingSensitive,
                  obscureText: !_revealCoupangAccessKey,
                  decoration: InputDecoration(
                    labelText: 'Coupang access key',
                    suffixIcon: IconButton(
                      onPressed: _sensitiveUnlocked
                          ? () => setState(() => _revealCoupangAccessKey =
                              !_revealCoupangAccessKey)
                          : null,
                      icon: Icon(_revealCoupangAccessKey
                          ? Icons.visibility_off
                          : Icons.visibility),
                      tooltip: _revealCoupangAccessKey ? 'Hide' : 'Reveal',
                    ),
                  ),
                ),
                const SizedBox(height: 10),
                TextField(
                  controller: _coupangSecretKey,
                  enabled: _sensitiveUnlocked && !_savingSensitive,
                  obscureText: !_revealCoupangSecretKey,
                  decoration: InputDecoration(
                    labelText: 'Coupang secret key',
                    suffixIcon: IconButton(
                      onPressed: _sensitiveUnlocked
                          ? () => setState(() => _revealCoupangSecretKey =
                              !_revealCoupangSecretKey)
                          : null,
                      icon: Icon(_revealCoupangSecretKey
                          ? Icons.visibility_off
                          : Icons.visibility),
                      tooltip: _revealCoupangSecretKey ? 'Hide' : 'Reveal',
                    ),
                  ),
                ),
                const SizedBox(height: 10),
                TextField(
                  controller: _coupangVendorId,
                  enabled: _sensitiveUnlocked && !_savingSensitive,
                  obscureText: !_revealCoupangVendorId,
                  decoration: InputDecoration(
                    labelText: 'Coupang vendorId',
                    helperText: '쿠팡 Wing의 판매자(Vendor) ID',
                    suffixIcon: IconButton(
                      onPressed: _sensitiveUnlocked
                          ? () => setState(() =>
                              _revealCoupangVendorId = !_revealCoupangVendorId)
                          : null,
                      icon: Icon(_revealCoupangVendorId
                          ? Icons.visibility_off
                          : Icons.visibility),
                      tooltip: _revealCoupangVendorId ? 'Hide' : 'Reveal',
                    ),
                  ),
                ),
                const SizedBox(height: 10),
                TextField(
                  controller: _coupangVendorUserId,
                  enabled: _sensitiveUnlocked && !_savingSensitive,
                  obscureText: !_revealCoupangVendorUserId,
                  decoration: InputDecoration(
                    labelText: 'Coupang vendorUserId',
                    helperText: '쿠팡 Wing 로그인 계정 ID(또는 사용자 식별자)',
                    suffixIcon: IconButton(
                      onPressed: _sensitiveUnlocked
                          ? () => setState(() => _revealCoupangVendorUserId =
                              !_revealCoupangVendorUserId)
                          : null,
                      icon: Icon(_revealCoupangVendorUserId
                          ? Icons.visibility_off
                          : Icons.visibility),
                      tooltip: _revealCoupangVendorUserId ? 'Hide' : 'Reveal',
                    ),
                  ),
                ),
                const SizedBox(height: 10),
                TextField(
                  controller: _coupangDeliveryCompanyCode,
                  enabled: _sensitiveUnlocked && !_savingSensitive,
                  obscureText: !_revealCoupangDeliveryCompanyCode,
                  decoration: InputDecoration(
                    labelText: 'Coupang delivery company code',
                    helperText:
                        '쿠팡 배송사 코드 (기본값은 CJ대한통운=KOREA_POST 등 아님, 환경에 따라 다름)',
                    suffixIcon: IconButton(
                      onPressed: _sensitiveUnlocked
                          ? () => setState(() =>
                              _revealCoupangDeliveryCompanyCode =
                                  !_revealCoupangDeliveryCompanyCode)
                          : null,
                      icon: Icon(_revealCoupangDeliveryCompanyCode
                          ? Icons.visibility_off
                          : Icons.visibility),
                      tooltip:
                          _revealCoupangDeliveryCompanyCode ? 'Hide' : 'Reveal',
                    ),
                  ),
                ),
                const SizedBox(height: 10),
                TextField(
                  controller: _pagesApiToken,
                  enabled: _sensitiveUnlocked && !_savingSensitive,
                  obscureText: !_revealPagesApiToken,
                  decoration: InputDecoration(
                    labelText: 'Cloudflare (Pages) API token',
                    suffixIcon: IconButton(
                      onPressed: _sensitiveUnlocked
                          ? () => setState(() =>
                              _revealPagesApiToken = !_revealPagesApiToken)
                          : null,
                      icon: Icon(_revealPagesApiToken
                          ? Icons.visibility_off
                          : Icons.visibility),
                      tooltip: _revealPagesApiToken ? 'Hide' : 'Reveal',
                    ),
                  ),
                ),
                const SizedBox(height: 14),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: (_savingSensitive ||
                            !_sensitiveUnlocked ||
                            authedEmail.isEmpty)
                        ? null
                        : _saveSensitive,
                    child: _savingSensitive
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2))
                        : Text(
                            authedEmail.isEmpty ? 'Sign in to save' : 'Save'),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SectionHeader('Server'),
                const SizedBox(height: 10),
                const KvRow(k: 'Base URL', v: ApiClient.defaultBaseUrl),
                const KvRow(
                    k: 'Dashboard',
                    v: '${ApiClient.defaultBaseUrl}/api/dashboard'),
                const Divider(height: 24),
                SizedBox(
                  width: double.infinity,
                  child: OutlinedButton.icon(
                    icon: const Icon(Icons.open_in_new),
                    onPressed: () {
                      Navigator.of(context).push(
                        MaterialPageRoute(
                          builder: (_) => const WebviewScreen(
                            title: 'Web Dashboard',
                            url: ApiClient.defaultBaseUrl,
                          ),
                        ),
                      );
                    },
                    label: const Text('Open web dashboard'),
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  'Tip: WebView는 서버 HTML UI를 그대로 띄웁니다. 모바일 API 세션은 위 Login 버튼으로 저장돼요.',
                  style: TextStyle(
                      fontSize: 12,
                      color: Theme.of(context)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: 0.60)),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
