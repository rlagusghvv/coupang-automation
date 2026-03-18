import 'package:couplus_mobile/api/api_client.dart';
import 'package:couplus_mobile/screens/order_detail_screen.dart';
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

  // Search / filter
  final _q = TextEditingController();
  String _status = '';
  bool _onlyTodo = false;

  Map<String, dynamic>? _lastExport;
  Map<String, dynamic>? _lastShippingRefresh;
  Map<String, dynamic>? _lastUpload;

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
    _q.dispose();
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
    final direct = (_lastExport?['downloadUrl'] ?? '').toString();
    final fp = (_lastExport?['filePath'] ?? '').toString();
    if (direct.isEmpty && fp.isEmpty) return;
    final fileName = fp.isEmpty ? '' : fp.split('/').last;
    final url = direct.isNotEmpty
        ? direct
        : '${widget.api.baseUrl}/couplus-out/order_exports/$fileName';
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

  Future<void> _uploadToDomeme() async {
    final filePath = (_lastExport?['filePath'] ?? '').toString();
    if (filePath.isEmpty) {
      setState(() => _error = '먼저 엑셀을 생성해 주세요.');
      return;
    }

    setState(() {
      _loading = true;
      _error = null;
      _lastUpload = null;
    });

    try {
      final json = await widget.api.postJson('/api/orders/upload', {
        'vendor': 'domeme',
        'filePath': filePath,
      });
      final result = (json['result'] as Map?)?.cast<String, dynamic>() ?? {};
      setState(() => _lastUpload = result);

      if (mounted) {
        final payUrl = (result['payUrl'] ?? '').toString();
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              result['ok'] == true
                  ? (payUrl.startsWith('http') ? '업로드 완료, 결제 링크를 찾았어요.' : '업로드 완료')
                  : '업로드 결과를 확인해 주세요.',
            ),
          ),
        );
      }
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _openPayUrl() async {
    final payUrl = (_lastUpload?['payUrl'] ?? '').toString();
    if (!payUrl.startsWith('http')) return;
    final uri = Uri.tryParse(payUrl);
    if (uri != null) {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    }
  }

  bool _isTodoStatus(String st) {
    final s = st.trim().toUpperCase();
    return s == 'ACCEPT' || s == 'INSTRUCT' || s == 'READY';
  }

  Widget _statusChip(BuildContext context, String value, String label) {
    final active = _status == value;
    final c = active
        ? Theme.of(context).colorScheme.primary
        : Theme.of(context).colorScheme.outline;
    return InkWell(
      borderRadius: BorderRadius.circular(999),
      onTap: _loading
          ? null
          : () {
              setState(() => _status = value);
            },
      child: InfoChip(label: label, color: c),
    );
  }

  @override
  Widget build(BuildContext context) {
    final last = _lastExport;
    final lastOk = last == null ? null : (last['ok'] == true);
    final lastUpload = _lastUpload;
    final lastUploadOk = lastUpload == null ? null : (lastUpload['ok'] == true);
    final lastUploadPayUrl = (lastUpload?['payUrl'] ?? '').toString();

    final q = _q.text.trim().toLowerCase();
    final filtered = _orders.where((o) {
      final st = (o['status'] ?? '').toString();
      if (_status.trim().isNotEmpty && st != _status) return false;
      if (_onlyTodo && !_isTodoStatus(st)) return false;

      if (q.isEmpty) return true;
      final raw = (o['order'] as Map?)?.cast<String, dynamic>() ?? {};
      final sheet = (raw['sheet'] as Map?)?.cast<String, dynamic>() ?? {};
      final item = (raw['item'] as Map?)?.cast<String, dynamic>() ?? {};
      final receiver = (sheet['receiver'] as Map?)?.cast<String, dynamic>() ?? {};

      final title = (item['vendorItemName'] ?? item['sellerProductName'] ?? '').toString().toLowerCase();
      final name = (receiver['name'] ?? '').toString().toLowerCase();
      return title.contains(q) || name.contains(q);
    }).toList();

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

          TextField(
            controller: _q,
            onChanged: (_) => setState(() {}),
            decoration: const InputDecoration(
              labelText: '검색 (상품명 / 받는 사람)',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: SwitchListTile.adaptive(
                  value: _onlyTodo,
                  onChanged: _loading ? null : (v) => setState(() => _onlyTodo = v),
                  title: const Text('해야 할 주문만 보기'),
                  subtitle: const Text('접수/지시 같은 처리 전 상태만 보여줘요.'),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                _statusChip(context, '', '전체'),
                const SizedBox(width: 8),
                _statusChip(context, 'ACCEPT', '접수'),
                const SizedBox(width: 8),
                _statusChip(context, 'INSTRUCT', '지시'),
                const SizedBox(width: 8),
                _statusChip(context, 'DELIVERING', '배송중'),
                const SizedBox(width: 8),
                _statusChip(context, 'DONE', '완료'),
              ],
            ),
          ),

          const SizedBox(height: 12),
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
                      child: FilledButton(
                        onPressed: _loading || last == null || lastOk != true ? null : _uploadToDomeme,
                        child: const Text('도매매 업로드'),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: FilledButton.tonal(
                        onPressed: _loading || !lastUploadPayUrl.startsWith('http') ? null : _openPayUrl,
                        child: const Text('결제 링크 열기'),
                      ),
                    ),
                  ],
                ),
                if (lastUpload != null) ...[
                  const SizedBox(height: 10),
                  KvRow(k: 'upload.ok', v: lastUploadOk == true ? 'true' : 'false'),
                  KvRow(k: 'vendor', v: (lastUpload['vendor'] ?? 'domeme').toString()),
                  KvRow(
                    k: 'payUrl',
                    v: lastUploadPayUrl.isEmpty ? '-' : lastUploadPayUrl,
                  ),
                  if ((lastUpload['warning'] ?? '').toString().isNotEmpty)
                    KvRow(k: 'warning', v: (lastUpload['warning'] ?? '').toString()),
                  if ((lastUpload['error'] ?? '').toString().isNotEmpty)
                    KvRow(k: 'error', v: (lastUpload['error'] ?? '').toString()),
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
                label: _loading ? '불러오는 중…' : '주문 ${filtered.length}건',
                color: Theme.of(context).colorScheme.primary,
              ),
            ],
          ),
          const SizedBox(height: 12),
          if (filtered.isEmpty && !_loading)
            AppCard(
              child: Text(
                _orders.isEmpty
                    ? '아직 주문이 없어요.\n\n1) 더보기 탭에서 쿠팡 키를 먼저 넣어 주세요.\n2) 여기로 돌아와서 “쿠팡 최신 상태 다시 가져오기”를 눌러 주세요.\n3) 마지막으로 “엑셀 생성”을 누르면 됩니다.'
                    : '조건에 맞는 주문이 없어요.\n\n검색어/필터를 지우고 다시 확인해 주세요.',
                style: TextStyle(
                  color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.7),
                ),
              ),
            )
          else
            Expanded(
              child: ListView.separated(
                itemCount: filtered.length,
                separatorBuilder: (_, __) => const SizedBox(height: 10),
                itemBuilder: (ctx, i) {
                  final o = filtered[i];
                  final id = (o['id'] ?? '').toString();
                  final status = (o['status'] ?? '').toString();

                  // Server stores raw payload under `order`.
                  final raw = (o['order'] as Map?)?.cast<String, dynamic>() ?? {};
                  // sheet is available if needed later
                  // final sheet = (raw['sheet'] as Map?)?.cast<String, dynamic>() ?? {};
                  final item = (raw['item'] as Map?)?.cast<String, dynamic>() ?? {};

                  final title = (item['vendorItemName'] ?? item['sellerProductName'] ?? '').toString();
                  final qty = (item['shippingCount'] ?? '').toString();

                  return AppCard(
                    onTap: () {
                      Navigator.of(context).push(
                        MaterialPageRoute(
                          builder: (_) => OrderDetailScreen(order: o),
                        ),
                      );
                    },
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          title.isEmpty ? '(상품명 없음)' : title,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontWeight: FontWeight.w900),
                        ),
                        const SizedBox(height: 8),
                        Wrap(
                          spacing: 8,
                          runSpacing: 6,
                          children: [
                            if (status.isNotEmpty)
                              InfoChip(label: status, color: Theme.of(context).colorScheme.primary),
                            if (qty.isNotEmpty)
                              InfoChip(label: '수량 $qty', color: Theme.of(context).colorScheme.outline),
                            if (id.isNotEmpty)
                              InfoChip(label: id, color: Theme.of(context).colorScheme.outline),
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
