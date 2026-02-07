import 'dart:convert';

import 'package:couplus_mobile/api/api_client.dart';
import 'package:couplus_mobile/ui/widgets.dart';
import 'package:flutter/material.dart';

class CatalogEventsScreen extends StatefulWidget {
  const CatalogEventsScreen({
    super.key,
    required this.api,
    required this.catalogId,
    this.title,
  });

  final ApiClient api;
  final String catalogId;
  final String? title;

  @override
  State<CatalogEventsScreen> createState() => _CatalogEventsScreenState();
}

class _CatalogEventsScreenState extends State<CatalogEventsScreen> {
  bool _loading = false;
  String? _error;
  List<Map<String, dynamic>> _events = const [];

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
      final json = await widget.api.getJson(
        '/api/catalog/${widget.catalogId}/events',
        query: {'limit': '200'},
      );
      final list = (json['events'] as List?) ?? const [];
      setState(() {
        _events = list.map((e) => (e as Map).cast<String, dynamic>()).toList();
      });
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: widget.title ?? '이벤트',
      onRefresh: _refresh,
      actions: [
        IconButton(
          onPressed: _loading ? null : _refresh,
          icon: const Icon(Icons.refresh),
        ),
      ],
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (_error != null) ErrorBanner(message: _error!, onRetry: _refresh),
          if (_error != null) const SizedBox(height: 12),
          Row(
            children: [
              InfoChip(
                label: _loading ? '불러오는 중…' : '총 ${_events.length}건',
                color: Theme.of(context).colorScheme.primary,
              ),
            ],
          ),
          const SizedBox(height: 12),
          if (_events.isEmpty && !_loading)
            AppCard(
              child: Text(
                '이벤트가 없어요.',
                style: TextStyle(
                  color: Theme.of(context)
                      .colorScheme
                      .onSurface
                      .withValues(alpha: 0.7),
                ),
              ),
            )
          else
            Expanded(
              child: ListView.separated(
                itemCount: _events.length,
                separatorBuilder: (_, __) => const SizedBox(height: 10),
                itemBuilder: (ctx, i) {
                  final e = _events[i];
                  final type = (e['type'] ?? '').toString();
                  final severity = (e['severity'] ?? '').toString();
                  final msg = (e['message'] ?? '').toString();
                  final at = (e['createdAt'] ?? '').toString();
                  final data = (e['data'] as Map?)?.cast<String, dynamic>();

                  Color color = Theme.of(context).colorScheme.primary;
                  if (severity == 'warn') color = const Color(0xFFE67700);
                  if (severity == 'error') color = const Color(0xFFE03131);

                  String dataText = '';
                  if (data != null && data.isNotEmpty) {
                    dataText = const JsonEncoder.withIndent('  ').convert(data);
                  }

                  return AppCard(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Wrap(
                          spacing: 8,
                          runSpacing: 6,
                          children: [
                            InfoChip(label: type, color: color),
                            if (at.isNotEmpty)
                              InfoChip(
                                label: at.replaceFirst('T', ' ').split('.').first,
                                color: Theme.of(context).colorScheme.outline,
                              ),
                          ],
                        ),
                        if (msg.isNotEmpty) ...[
                          const SizedBox(height: 8),
                          Text(
                            msg,
                            style: const TextStyle(fontWeight: FontWeight.w800),
                          ),
                        ],
                        if (dataText.isNotEmpty) ...[
                          const SizedBox(height: 8),
                          Text(
                            dataText,
                            style: TextStyle(
                              fontFamily: 'monospace',
                              fontSize: 12,
                              color: Theme.of(context)
                                  .colorScheme
                                  .onSurface
                                  .withValues(alpha: 0.7),
                            ),
                          ),
                        ],
                      ],
                    ),
                  );
                },
              ),
            ),
        ],
      ),
    );
  }
}
