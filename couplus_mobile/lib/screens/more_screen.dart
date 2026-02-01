import 'package:couplus_mobile/api/api_client.dart';
import 'package:couplus_mobile/screens/auth/webview_screen.dart';
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

  bool _loading = false;
  String? _error;
  Map<String, dynamic>? _me;

  @override
  void initState() {
    super.initState();
    _refreshMe();
  }

  @override
  void dispose() {
    _email.dispose();
    _pw.dispose();
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
    } catch (e) {
      setState(() {
        _me = null;
        _error = e.toString();
      });
    } finally {
      if (mounted) setState(() => _loading = false);
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
        IconButton(onPressed: _loading ? null : _refreshMe, icon: const Icon(Icons.refresh)),
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
                SectionHeader('Account', trailing: _loading ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) : null),
                const SizedBox(height: 10),
                KvRow(k: 'Session cookie', v: widget.api.cookie == null ? '-' : 'Saved'),
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
                const SectionHeader('Server'),
                const SizedBox(height: 10),
                const KvRow(k: 'Base URL', v: ApiClient.defaultBaseUrl),
                const KvRow(k: 'Dashboard', v: '${ApiClient.defaultBaseUrl}/api/dashboard'),
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
                  style: TextStyle(fontSize: 12, color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.60)),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
