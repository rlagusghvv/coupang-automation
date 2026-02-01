import 'package:couplus_mobile/api/api_client.dart';
import 'package:flutter/material.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.api});

  final ApiClient api;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  Map<String, dynamic>? _data;
  String? _error;
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final json = await widget.api.getJson('/api/dashboard');
      setState(() => _data = json);
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final data = _data;
    final auth = (data?['auth'] as Map?) ?? {};
    final sessionStatus = (data?['sessionStatus'] as Map?) ?? {};

    final domeme = (sessionStatus['domeme'] as Map?) ?? {};
    final domeggook = (sessionStatus['domeggook'] as Map?) ?? {};

    final previewHistory = (data?['previewHistory'] as List?) ?? const [];
    final purchaseLogs = (data?['purchaseLogs'] as List?) ?? const [];
    final payUrls = (data?['payUrls'] as Map?) ?? {};

    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text('Couplus', style: Theme.of(context).textTheme.headlineSmall),
              IconButton(
                onPressed: _loading ? null : _refresh,
                icon: const Icon(Icons.refresh),
              ),
            ],
          ),
          if (_loading) const LinearProgressIndicator(),
          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
          ],
          const SizedBox(height: 16),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Auth'),
                  const SizedBox(height: 8),
                  Text('authenticated: ${auth['authenticated'] ?? false}'),
                  Text('user: ${auth['user'] ?? '-'}'),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Session status'),
                  const SizedBox(height: 8),
                  Text('domeme: ${domeme['valid'] == true ? 'valid' : 'missing'}'),
                  Text('domeggook: ${domeggook['valid'] == true ? 'valid' : 'missing'}'),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Recent activity'),
                  const SizedBox(height: 8),
                  Text('previewHistory: ${previewHistory.length}'),
                  Text('purchaseLogs: ${purchaseLogs.length}'),
                  Text('payUrls: ${payUrls.keys.length}'),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
