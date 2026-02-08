import 'package:couplus_mobile/api/api_client.dart';
import 'package:couplus_mobile/ui/widgets.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

class OrdersScreen extends StatefulWidget {
  const OrdersScreen({super.key, required this.api});

  final ApiClient api;

  @override
  State<OrdersScreen> createState() => _OrdersScreenState();
}

class _OrdersScreenState extends State<OrdersScreen> {
  bool _loading = false;
  String? _error;
  List<Map<String, dynamic>> _orders = const [];

  final _dateFrom = TextEditingController();
  final _dateTo = TextEditingController();

  Map<String, dynamic>? _lastExport;
  Map<String, dynamic>? _lastShippingRefresh;

  @override
  void initState() {
    super.initState();

    final now = DateTime.now();
    final from = now.subtract(const Duration(days: 6));
    _dateFrom.text = _fmt(from);
    _dateTo.text = _fmt(now);

    _refresh();
  }

  @override
  void dispose() {
    _dateFrom.dispose();
    _dateTo.dispose();
    super.dispose();
  }

  String _fmt(DateTime d) {
    final y = d.year.toString().padLeft(4, '0');
    final m = d.month.toString().padLeft(2, '0');
    final day = d.day.toString().padLeft(2, '0');
    return '$y-$m-$day';
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final json = await widget.api.getJson('/api/orders', query: {'limit': '200'});
      final list = (json['orders'] as List?) ?? const [];
      setState(() {
        _orders = list.map((e) => (e as Map).cast<String, dynamic>()).toList();
      });
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _export() async {
    setState(() {
      _loading = true;
      _error = null;
      _lastExport = null;
    });

    try {
      final json = await widget.api.postJson('/api/orders/export', {
        'dateFrom': _dateFrom.text.trim(),
        'dateTo': _dateTo.text.trim(),
      });
      final result = (json['result'] as Map?)?.cast<String, dynamic>() ?? {};
      setState(() => _lastExport = result);

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(result['ok'] == true ? '엑셀 생성 완료' : '엑셀 생성 결과 확인')),
        );
      }
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _openExport() async {
    final fp = (_lastExport?['filePath'] ?? '').toString();
    if (fp.isEmpty) return;
    final fileName = fp.split('/').last;
    final url = '${widget.api.baseUrl}/couplus-out/order_exports/$fileName';
    final uri = Uri.tryParse(url);
    if (uri != null) {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    }
  }

  Future<void> _refreshShipping() async {
    setState(() {
      _loading = true;
      _error = null;
      _lastShippingRefresh = null;
    });

    try {
      final json = await widget.api.postJson('/api/orders/shipping/refresh', {
        'dateFrom': _dateFrom.text.trim(),
        'dateTo': _dateTo.text.trim(),
        'status': 'ACCEPT',
      });
      final result = (json['result'] as Map?)?.cast<String, dynamic>() ?? {};
      setState(() => _lastShippingRefresh = result);
      await _refresh();

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('쿠팡에서 최신 주문/배송상태를 다시 가져왔어요.')),
        );
      }
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final last = _lastExport;
    final lastOk = last == null ? null : (last['ok'] == true);

    return AppScaffold(
      title: '주문',
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

          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SectionHeader('쿠팡 → 도매매 엑셀'),
                const SizedBox(height: 10),
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _dateFrom,
                        decoration: const InputDecoration(
                          labelText: 'From (YYYY-MM-DD)',
                          border: OutlineInputBorder(),
                        ),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: TextField(
                        controller: _dateTo,
                        decoration: const InputDecoration(
                          labelText: 'To (YYYY-MM-DD)',
                          border: OutlineInputBorder(),
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                Row(
                  children: [
                    Expanded(
                      child: FilledButton(
                        onPressed: _loading ? null : _export,
                        child: const Text('엑셀 생성'),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: FilledButton.tonal(
                        onPressed: _loading || last == null || lastOk != true ? null : _openExport,
                        child: const Text('다운로드'),
                      ),
                    ),
                  ],
                ),
                if (last != null) ...[
                  const SizedBox(height: 10),
                  KvRow(k: 'ok', v: lastOk == true ? 'true' : 'false'),
                  KvRow(k: 'rowCount', v: (last['rowCount'] ?? '-').toString()),
                  KvRow(k: 'missingMapCount', v: (last['missingMapCount'] ?? '-').toString()),
                ],

                const SizedBox(height: 10),
                Row(
                  children: [
                    Expanded(
                      child: FilledButton.tonal(
                        onPressed: _loading ? null : _refreshShipping,
                        child: const Text('쿠팡 최신 상태 다시 가져오기'),
                      ),
                    ),
                  ],
                ),
                if (_lastShippingRefresh != null) ...[
                  const SizedBox(height: 10),
                  KvRow(k: 'shippingRefresh.mode', v: (_lastShippingRefresh?['mode'] ?? '-').toString()),
                  KvRow(k: 'scanned', v: (_lastShippingRefresh?['scanned'] ?? '-').toString()),
                  KvRow(k: 'updated', v: (_lastShippingRefresh?['updated'] ?? '-').toString()),
                ],
              ],
            ),
          ),

          const SizedBox(height: 12),
          Row(
            children: [
              InfoChip(
                label: _loading ? '불러오는 중…' : '저장된 주문 ${_orders.length}건',
                color: Theme.of(context).colorScheme.primary,
              ),
            ],
          ),
          const SizedBox(height: 12),
          if (_orders.isEmpty && !_loading)
            AppCard(
              child: Text(
                '아직 주문이 없어요.\n\n1) 위에서 “쿠팡 최신 상태 다시 가져오기”를 눌러 주세요.\n2) 그 다음 “엑셀 생성”을 누르면 됩니다.',
                style: TextStyle(
                  color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.7),
                ),
              ),
            )
          else
            Expanded(
              child: ListView.separated(
                itemCount: _orders.length,
                separatorBuilder: (_, __) => const SizedBox(height: 10),
                itemBuilder: (ctx, i) {
                  final o = _orders[i];
                  final id = (o['id'] ?? '').toString();
                  final status = (o['status'] ?? '').toString();
                  final title = (o['title'] ?? o['itemName'] ?? '').toString();
                  final qty = (o['qty'] ?? o['quantity'] ?? '').toString();

                  return AppCard(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          title.isEmpty ? '(제목 없음)' : title,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontWeight: FontWeight.w900),
                        ),
                        const SizedBox(height: 8),
                        Wrap(
                          spacing: 8,
                          runSpacing: 6,
                          children: [
                            if (status.isNotEmpty) InfoChip(label: status, color: Theme.of(context).colorScheme.primary),
                            if (qty.isNotEmpty) InfoChip(label: 'qty $qty', color: Theme.of(context).colorScheme.outline),
                            if (id.isNotEmpty) InfoChip(label: id, color: Theme.of(context).colorScheme.outline),
                          ],
                        ),
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
