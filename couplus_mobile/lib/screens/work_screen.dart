import 'package:couplus_mobile/api/api_client.dart';
import 'package:flutter/material.dart';

class WorkScreen extends StatefulWidget {
  const WorkScreen({super.key, required this.api});

  final ApiClient api;

  @override
  State<WorkScreen> createState() => _WorkScreenState();
}

class _WorkScreenState extends State<WorkScreen> {
  List<dynamic> _history = const [];
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
      final json = await widget.api.getJson('/api/dashboard', query: {'previewLimit': '50'});
      final list = (json['previewHistory'] as List?) ?? const [];
      setState(() => _history = list);
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: 1 + _history.length,
        itemBuilder: (context, i) {
          if (i == 0) {
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text('Work', style: Theme.of(context).textTheme.headlineSmall),
                    IconButton(
                      onPressed: _loading ? null : _refresh,
                      icon: const Icon(Icons.refresh),
                    ),
                  ],
                ),
                if (_loading) const LinearProgressIndicator(),
                if (_error != null) ...[
                  const SizedBox(height: 12),
                  Text(_error!,
                      style: TextStyle(color: Theme.of(context).colorScheme.error)),
                ],
                const SizedBox(height: 12),
                const Text('Recent preview history (from /api/dashboard)'),
                const SizedBox(height: 8),
              ],
            );
          }

          final item = _history[i - 1] as Map? ?? {};
          final title = (item['title'] ?? '').toString();
          final url = (item['url'] ?? '').toString();
          final finalPrice = item['finalPrice'];

          return Card(
            margin: const EdgeInsets.only(bottom: 10),
            child: ListTile(
              title: Text(title.isEmpty ? '(no title)' : title),
              subtitle: Text(url),
              trailing: Text(finalPrice == null ? '-' : finalPrice.toString()),
            ),
          );
        },
      ),
    );
  }
}
