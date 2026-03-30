import 'package:couplus_mobile/api/api_client.dart';
import 'package:couplus_mobile/screens/order_detail_screen.dart';
import 'package:couplus_mobile/ui/widgets.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

class OrdersScreen extends StatefulWidget {
  const OrdersScreen({
    super.key,
    required this.api,
    this.initialStatus = '',
    this.initialStatuses = const <String>[],
    this.initialOnlyTodo = true,
    this.initialToolsExpanded = false,
    this.initialQuery = '',
    this.titleOverride,
    this.queueLabel,
  });

  final ApiClient api;
  final String initialStatus;
  final List<String> initialStatuses;
  final bool initialOnlyTodo;
  final bool initialToolsExpanded;
  final String initialQuery;
  final String? titleOverride;
  final String? queueLabel;

  @override
  State<OrdersScreen> createState() => _OrdersScreenState();
}

class _OrdersScreenState extends State<OrdersScreen> {
  bool _loading = false;
  bool _loadingDomeggookAsset = false;
  String? _error;
  List<Map<String, dynamic>> _orders = const [];
  Map<String, dynamic>? _domeggookAsset;

  final _dateFrom = TextEditingController();
  final _dateTo = TextEditingController();

  // Search / filter
  final _q = TextEditingController();
  String _status = '';
  bool _onlyTodo = true;
  bool _hideOldTodo = true;
  List<String> _queueStatuses = const [];
  String? _queueLabel;
  bool _toolsExpanded = false;
  bool _toolDetailsExpanded = false;

  Map<String, dynamic>? _lastExport;
  Map<String, dynamic>? _lastShippingRefresh;
  Map<String, dynamic>? _lastUpload;
  static const List<String> _syncStatuses = <String>[
    'ACCEPT',
    'INSTRUCT',
    'READY',
    'DELIVERING',
    'DONE',
  ];
  static const List<String> _exportStatuses = <String>[
    'ACCEPT',
    'INSTRUCT',
    'READY',
  ];

  @override
  void initState() {
    super.initState();

    final now = DateTime.now();
    final from = now.subtract(const Duration(days: 6));
    _dateFrom.text = _fmt(from);
    _dateTo.text = _fmt(now);
    _status = widget.initialStatus.trim();
    _onlyTodo = widget.initialOnlyTodo;
    _queueStatuses = widget.initialStatuses
        .map((e) => e.trim().toUpperCase())
        .where((e) => e.isNotEmpty)
        .toList(growable: false);
    _queueLabel = widget.queueLabel?.trim();
    _toolsExpanded = widget.initialToolsExpanded;
    if (widget.initialQuery.trim().isNotEmpty) {
      _q.text = widget.initialQuery.trim();
    }

    _refresh();
    _loadDomeggookAsset();
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

  String _formatWon(dynamic value) {
    final n = num.tryParse('${value ?? ''}');
    if (n == null) return '-';
    final text = n.toStringAsFixed(0);
    final out = StringBuffer();
    for (var i = 0; i < text.length; i++) {
      final idxFromEnd = text.length - i;
      out.write(text[i]);
      if (idxFromEnd > 1 && idxFromEnd % 3 == 1) out.write(',');
    }
    return '${out.toString()}원';
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final json =
          await widget.api.getJson('/api/orders', query: {'limit': '200'});
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

  Future<void> _loadDomeggookAsset() async {
    setState(() => _loadingDomeggookAsset = true);
    try {
      final json = await widget.api.getJson('/api/domeggook/private/asset');
      if (!mounted) return;
      setState(() => _domeggookAsset = json);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _domeggookAsset = {
          'ok': false,
          'error': e.toString(),
        };
      });
    } finally {
      if (mounted) setState(() => _loadingDomeggookAsset = false);
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
        'vendor': 'domeggook',
        'statuses': _exportStatuses,
      });
      final result = (json['result'] as Map?)?.cast<String, dynamic>() ?? {};
      setState(() => _lastExport = result);

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
              content: Text(result['ok'] == true ? '엑셀 생성 완료' : '엑셀 생성 결과 확인')),
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
      await launchUrl(uri, mode: LaunchMode.platformDefault);
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
        'statuses': _syncStatuses,
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
                  ? (payUrl.startsWith('http')
                      ? '업로드 완료, 결제 링크를 찾았어요.'
                      : '업로드 완료')
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
      await launchUrl(uri, mode: LaunchMode.platformDefault);
    }
  }

  Future<void> _openOrderDetail(Map<String, dynamic> order) async {
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => OrderDetailScreen(
          order: order,
          api: widget.api,
          onChanged: _refresh,
        ),
      ),
    );
  }

  Future<void> _acknowledgeQuick(Map<String, dynamic> order) async {
    final raw = (order['order'] as Map?)?.cast<String, dynamic>() ?? {};
    final sheet = (raw['sheet'] as Map?)?.cast<String, dynamic>() ?? {};
    final shipmentBoxId =
        (sheet['shipmentBoxId'] ?? order['externalId'] ?? '').toString().trim();
    if (shipmentBoxId.isEmpty) {
      setState(() => _error = 'shipmentBoxId가 없어 발주확인을 진행할 수 없습니다.');
      return;
    }

    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      await widget.api.postJson('/api/orders/coupang/acknowledge', {
        'shipmentBoxId': shipmentBoxId,
      });
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('발주확인 처리를 완료했습니다.')),
      );
      await _refresh();
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _uploadInvoiceQuick(Map<String, dynamic> order) async {
    final raw = (order['order'] as Map?)?.cast<String, dynamic>() ?? {};
    final sheet = (raw['sheet'] as Map?)?.cast<String, dynamic>() ?? {};
    final item = (raw['item'] as Map?)?.cast<String, dynamic>() ?? {};
    final shipmentBoxId =
        (sheet['shipmentBoxId'] ?? order['externalId'] ?? '').toString().trim();
    final orderId = (sheet['orderId'] ?? '').toString().trim();
    final vendorItemId = (item['vendorItemId'] ?? order['externalSubId'] ?? '')
        .toString()
        .trim();
    if (shipmentBoxId.isEmpty || orderId.isEmpty || vendorItemId.isEmpty) {
      setState(() => _error = '주문 식별값이 부족해 송장 업로드를 진행할 수 없습니다.');
      return;
    }

    final companyCtrl = TextEditingController();
    final invoiceCtrl = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) {
        return AlertDialog(
          title: const Text('빠른 송장 업로드'),
          content: SizedBox(
            width: 420,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                  controller: companyCtrl,
                  decoration: const InputDecoration(
                    labelText: '택배사 코드',
                    hintText: '예: KDEXP',
                  ),
                ),
                const SizedBox(height: 10),
                TextField(
                  controller: invoiceCtrl,
                  decoration: const InputDecoration(
                    labelText: '운송장 번호',
                  ),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: const Text('취소'),
            ),
            FilledButton(
              onPressed: () => Navigator.of(ctx).pop(true),
              child: const Text('업로드'),
            ),
          ],
        );
      },
    );
    final deliveryCompanyCode = companyCtrl.text.trim();
    final invoiceNumber = invoiceCtrl.text.trim();
    companyCtrl.dispose();
    invoiceCtrl.dispose();

    if (ok != true) return;
    if (invoiceNumber.isEmpty) {
      setState(() => _error = '운송장 번호를 입력해 주세요.');
      return;
    }

    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      await widget.api.postJson('/api/orders/coupang/invoices', {
        'items': [
          {
            'shipmentBoxId': shipmentBoxId,
            'orderId': orderId,
            'vendorItemId': vendorItemId,
            'deliveryCompanyCode': deliveryCompanyCode,
            'invoiceNumber': invoiceNumber,
          }
        ],
      });
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('송장 업로드를 완료했습니다.')),
      );
      await _refresh();
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  bool _isTodoStatus(String st) {
    final s = st.trim().toUpperCase();
    return s == 'ACCEPT' || s == 'INSTRUCT' || s == 'READY';
  }

  DateTime? _extractOrderDate(Map<String, dynamic> orderRow) {
    final order = (orderRow['order'] as Map?)?.cast<String, dynamic>() ?? {};
    final sheet = (order['sheet'] as Map?)?.cast<String, dynamic>() ?? {};
    final candidates = <String>[
      (sheet['orderDate'] ?? '').toString(),
      (sheet['orderedAt'] ?? '').toString(),
      (sheet['paidAt'] ?? '').toString(),
      (sheet['createdAt'] ?? '').toString(),
      (orderRow['at'] ?? '').toString(),
    ];
    for (final value in candidates) {
      if (value.trim().isEmpty) continue;
      final parsed = DateTime.tryParse(value.trim());
      if (parsed != null) return parsed;
    }
    return null;
  }

  bool _isOldTodoOrder(Map<String, dynamic> orderRow) {
    final status = (orderRow['status'] ?? '').toString();
    if (!_isTodoStatus(status)) return false;
    final dt = _extractOrderDate(orderRow);
    if (dt == null) return false;
    return DateTime.now().difference(dt.toLocal()) >= const Duration(days: 2);
  }

  String _orderAgeLabel(Map<String, dynamic> orderRow) {
    final dt = _extractOrderDate(orderRow);
    if (dt == null) return '';
    final now = DateTime.now();
    final diff = now.difference(dt.toLocal());
    if (diff.inDays <= 0) return '오늘';
    if (diff.inDays == 1) return '어제';
    return '${diff.inDays}일 전';
  }

  bool _matchesQueueStatus(String status) {
    if (_queueStatuses.isEmpty) return true;
    return _queueStatuses.contains(status.trim().toUpperCase());
  }

  String get _screenTitle {
    final override = widget.titleOverride?.trim() ?? '';
    return override.isNotEmpty ? override : '주문';
  }

  int _statusRank(String status) {
    final s = status.trim().toUpperCase();
    switch (s) {
      case 'ACCEPT':
        return 0;
      case 'INSTRUCT':
        return 1;
      case 'READY':
        return 2;
      case 'DELIVERING':
        return 3;
      case 'DONE':
        return 4;
      default:
        return 9;
    }
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
    final filteredAll = _orders.where((o) {
      final st = (o['status'] ?? '').toString();
      if (!_matchesQueueStatus(st)) return false;
      if (_status.trim().isNotEmpty && st != _status) return false;
      if (_onlyTodo && !_isTodoStatus(st)) return false;

      if (q.isEmpty) return true;
      final raw = (o['order'] as Map?)?.cast<String, dynamic>() ?? {};
      final sheet = (raw['sheet'] as Map?)?.cast<String, dynamic>() ?? {};
      final item = (raw['item'] as Map?)?.cast<String, dynamic>() ?? {};
      final receiver =
          (sheet['receiver'] as Map?)?.cast<String, dynamic>() ?? {};

      final title = (item['vendorItemName'] ?? item['sellerProductName'] ?? '')
          .toString()
          .toLowerCase();
      final name = (receiver['name'] ?? '').toString().toLowerCase();
      return title.contains(q) || name.contains(q);
    }).toList()
      ..sort((a, b) {
        final sa = (a['status'] ?? '').toString();
        final sb = (b['status'] ?? '').toString();
        final statusCmp = _statusRank(sa).compareTo(_statusRank(sb));
        if (statusCmp != 0) return statusCmp;
        final atA = _extractOrderDate(a)?.millisecondsSinceEpoch ?? 0;
        final atB = _extractOrderDate(b)?.millisecondsSinceEpoch ?? 0;
        return atB.compareTo(atA);
      });
    final hiddenOldTodoCount =
        filteredAll.where(_isOldTodoOrder).length;
    final filtered = _hideOldTodo
        ? filteredAll.where((o) => !_isOldTodoOrder(o)).toList()
        : filteredAll;

    final acceptCount = _orders
        .where((o) =>
            (o['status'] ?? '').toString().trim().toUpperCase() == 'ACCEPT')
        .length;
    final todoCount = _orders
        .where((o) => _isTodoStatus((o['status'] ?? '').toString()))
        .length;
    final deliveringCount = _orders
        .where((o) =>
            (o['status'] ?? '').toString().trim().toUpperCase() == 'DELIVERING')
        .length;
    final doneCount = _orders
        .where((o) =>
            (o['status'] ?? '').toString().trim().toUpperCase() == 'DONE')
        .length;
    final domeggookAssetMap =
        (_domeggookAsset?['asset'] as Map?)?.cast<String, dynamic>() ?? {};
    final domeggookCash = domeggookAssetMap['emoneyCash'];
    final domeggookAssetError = (_domeggookAsset?['error'] ?? '').toString();

    return AppScaffold(
      title: _screenTitle,
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
                const SectionHeader('오늘 주문 상태'),
                const SizedBox(height: 12),
                Wrap(
                  spacing: 10,
                  runSpacing: 10,
                  children: [
                    _OrderMetric(
                        title: '해야 할 주문',
                        value: '$todoCount',
                        subtitle: '지금 처리 대상'),
                    _OrderMetric(
                        title: '새 주문',
                        value: '$acceptCount',
                        subtitle: '먼저 발주확인'),
                    _OrderMetric(
                        title: '배송중',
                        value: '$deliveringCount',
                        subtitle: '송장 반영 후 상태'),
                    _OrderMetric(
                        title: '완료', value: '$doneCount', subtitle: '처리 끝난 주문'),
                  ],
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    InfoChip(
                      label: _loadingDomeggookAsset
                          ? 'e머니 확인 중'
                          : domeggookAssetMap.isNotEmpty
                              ? '현금성 e머니 ${_formatWon(domeggookCash)}'
                              : 'e머니 미확인',
                      color: domeggookAssetMap.isNotEmpty &&
                              (num.tryParse('${domeggookCash ?? ''}') ?? 0) > 0
                          ? Theme.of(context).colorScheme.primary
                          : Theme.of(context).colorScheme.outline,
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        domeggookAssetMap.isNotEmpty
                            ? '주문 상세에 들어가기 전에도 잔액을 바로 볼 수 있습니다.'
                            : (domeggookAssetError.isNotEmpty
                                ? '도매꾹 잔액 조회에 실패했습니다. 연결 상태를 확인하세요.'
                                : '도매꾹 자동 주문 전 현금성 e머니를 먼저 확인합니다.'),
                        style: TextStyle(
                          color: Theme.of(context)
                              .colorScheme
                              .onSurface
                              .withValues(alpha: 0.68),
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    TextButton(
                      onPressed: _loadingDomeggookAsset
                          ? null
                          : _loadDomeggookAsset,
                      child: const Text('잔액 확인'),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                Wrap(
                  spacing: 10,
                  runSpacing: 10,
                  children: [
                    FilledButton.tonalIcon(
                      onPressed: _loading ? null : _refreshShipping,
                      icon: const Icon(Icons.sync),
                      label: const Text('쿠팡 상태 동기화'),
                    ),
                    FilledButton.tonalIcon(
                      onPressed: _loading ? null : _export,
                      icon: const Icon(Icons.description_outlined),
                      label: const Text('엑셀 생성'),
                    ),
                    FilledButton.tonalIcon(
                      onPressed: _loading || last == null || lastOk != true
                          ? null
                          : _openExport,
                      icon: const Icon(Icons.download_outlined),
                      label: const Text('다운로드'),
                    ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          if (_queueStatuses.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: AppCard(
                child: Row(
                  children: [
                    InfoChip(
                      label: _queueLabel?.isNotEmpty == true
                          ? _queueLabel!
                          : '주문 큐',
                      color: Theme.of(context).colorScheme.primary,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        '이 화면은 ${_queueStatuses.join(', ')} 상태 주문만 보여줍니다.',
                        style: TextStyle(
                          color: Theme.of(context)
                              .colorScheme
                              .onSurface
                              .withValues(alpha: 0.68),
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    TextButton(
                      onPressed: _loading
                          ? null
                          : () {
                              setState(() {
                                _queueStatuses = const [];
                                _queueLabel = null;
                              });
                            },
                      child: const Text('큐 해제'),
                    ),
                  ],
                ),
              ),
            ),
          TextField(
            controller: _q,
            onChanged: (_) => setState(() {}),
            decoration: const InputDecoration(
              labelText: '검색 (상품명 / 받는 사람)',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 8),
          SwitchListTile.adaptive(
            value: _onlyTodo,
            onChanged: _loading ? null : (v) => setState(() => _onlyTodo = v),
            contentPadding: EdgeInsets.zero,
            title: const Text('해야 할 주문만 보기'),
            subtitle: const Text('접수/지시 같은 처리 전 상태만 남깁니다.'),
          ),
          SwitchListTile.adaptive(
            value: _hideOldTodo,
            onChanged:
                _loading ? null : (v) => setState(() => _hideOldTodo = v),
            contentPadding: EdgeInsets.zero,
            title: const Text('이전 미처리 주문 숨기기'),
            subtitle: const Text('2일 이상 지난 미처리 주문은 기본으로 가립니다.'),
          ),
          const SizedBox(height: 6),
          if (_hideOldTodo && hiddenOldTodoCount > 0) ...[
            AppCard(
              child: Row(
                children: [
                  InfoChip(
                    label: '이전 주문 $hiddenOldTodoCount건 숨김',
                    color: Theme.of(context).colorScheme.outline,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      '오래된 주문은 기본으로 숨겼습니다. 필요하면 토글을 꺼서 다시 볼 수 있습니다.',
                      style: TextStyle(
                        color: Theme.of(context)
                            .colorScheme
                            .onSurface
                            .withValues(alpha: 0.68),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 8),
          ],
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
                _statusChip(context, 'READY', '준비'),
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
                SectionHeader(
                  '공급처 주문 도구',
                  trailing: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (_toolsExpanded)
                        TextButton(
                          onPressed: _loading
                              ? null
                              : () => setState(
                                    () => _toolDetailsExpanded =
                                        !_toolDetailsExpanded,
                                  ),
                          child:
                              Text(_toolDetailsExpanded ? '결과 숨기기' : '결과 보기'),
                        ),
                      TextButton(
                        onPressed: _loading
                            ? null
                            : () => setState(
                                () => _toolsExpanded = !_toolsExpanded),
                        child: Text(_toolsExpanded ? '접기' : '펼치기'),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  '주문 처리에 꼭 필요할 때만 펼쳐서 씁니다. 발주확인 후 주문도 엑셀에 포함되도록 접수/지시/준비 상태를 함께 사용합니다.',
                  style: TextStyle(
                    color: Theme.of(context)
                        .colorScheme
                        .onSurface
                        .withValues(alpha: 0.68),
                  ),
                ),
                if (_toolsExpanded) ...[
                  const SizedBox(height: 12),
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
                  Wrap(
                    spacing: 10,
                    runSpacing: 10,
                    children: [
                      FilledButton(
                        onPressed: _loading || last == null || lastOk != true
                            ? null
                            : _uploadToDomeme,
                        child: const Text('도매매 업로드'),
                      ),
                      FilledButton.tonal(
                        onPressed:
                            _loading || !lastUploadPayUrl.startsWith('http')
                                ? null
                                : _openPayUrl,
                        child: const Text('결제 링크 열기'),
                      ),
                    ],
                  ),
                  if (_toolDetailsExpanded && last != null) ...[
                    const SizedBox(height: 10),
                    KvRow(k: 'ok', v: lastOk == true ? 'true' : 'false'),
                    KvRow(
                        k: 'rowCount', v: (last['rowCount'] ?? '-').toString()),
                    KvRow(
                        k: 'missingMapCount',
                        v: (last['missingMapCount'] ?? '-').toString()),
                    if ((last['error'] ?? '').toString().isNotEmpty)
                      KvRow(k: 'error', v: (last['error'] ?? '').toString()),
                  ],
                  if (_toolDetailsExpanded && lastUpload != null) ...[
                    const SizedBox(height: 10),
                    KvRow(
                        k: 'upload.ok',
                        v: lastUploadOk == true ? 'true' : 'false'),
                    KvRow(
                        k: 'vendor',
                        v: (lastUpload['vendor'] ?? 'domeme').toString()),
                    KvRow(
                        k: 'payUrl',
                        v: lastUploadPayUrl.isEmpty ? '-' : lastUploadPayUrl),
                    if ((lastUpload['warning'] ?? '').toString().isNotEmpty)
                      KvRow(
                          k: 'warning',
                          v: (lastUpload['warning'] ?? '').toString()),
                    if ((lastUpload['error'] ?? '').toString().isNotEmpty)
                      KvRow(
                          k: 'error',
                          v: (lastUpload['error'] ?? '').toString()),
                  ],
                  if (_toolDetailsExpanded && _lastShippingRefresh != null) ...[
                    const SizedBox(height: 10),
                    KvRow(
                        k: 'shippingRefresh.mode',
                        v: (_lastShippingRefresh?['mode'] ?? '-').toString()),
                    KvRow(
                        k: 'scanned',
                        v: (_lastShippingRefresh?['scanned'] ?? '-')
                            .toString()),
                    KvRow(
                        k: 'updated',
                        v: (_lastShippingRefresh?['updated'] ?? '-')
                            .toString()),
                  ],
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
                  color: Theme.of(context)
                      .colorScheme
                      .onSurface
                      .withValues(alpha: 0.7),
                ),
              ),
            )
          else
            ListView.separated(
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              itemCount: filtered.length,
              separatorBuilder: (_, __) => const SizedBox(height: 10),
              itemBuilder: (ctx, i) {
                final o = filtered[i];
                final id = (o['id'] ?? '').toString();
                final status = (o['status'] ?? '').toString();

                // Server stores raw payload under `order`.
                final raw = (o['order'] as Map?)?.cast<String, dynamic>() ?? {};
                final sheet =
                    (raw['sheet'] as Map?)?.cast<String, dynamic>() ?? {};
                final item =
                    (raw['item'] as Map?)?.cast<String, dynamic>() ?? {};
                final receiver =
                    (sheet['receiver'] as Map?)?.cast<String, dynamic>() ?? {};

                final title =
                    (item['vendorItemName'] ?? item['sellerProductName'] ?? '')
                        .toString();
                final qty = (item['shippingCount'] ?? '').toString();
                final receiverName = (receiver['name'] ?? '').toString();
                final receiverPhone =
                    (receiver['receiverNumber'] ?? receiver['safeNumber'] ?? '')
                        .toString();
                final ageLabel = _orderAgeLabel(o);
                final needsAction = _isTodoStatus(status);
                final canQuickAck = status.trim().toUpperCase() == 'ACCEPT';
                final canQuickInvoice = const {
                  'INSTRUCT',
                  'READY',
                  'DELIVERING',
                }.contains(status.trim().toUpperCase());

                return AppCard(
                  onTap: () => _openOrderDetail(o),
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
                            InfoChip(
                                label: status,
                                color: Theme.of(context).colorScheme.primary),
                          if (qty.isNotEmpty)
                            InfoChip(
                                label: '수량 $qty',
                                color: Theme.of(context).colorScheme.outline),
                          if (ageLabel.isNotEmpty)
                            InfoChip(
                              label: ageLabel,
                              color: _isOldTodoOrder(o)
                                  ? const Color(0xFFE67700)
                                  : Theme.of(context).colorScheme.outline,
                            ),
                          if (id.isNotEmpty)
                            InfoChip(
                                label: id,
                                color: Theme.of(context).colorScheme.outline),
                        ],
                      ),
                      if (receiverName.isNotEmpty ||
                          receiverPhone.isNotEmpty) ...[
                        const SizedBox(height: 8),
                        Text(
                          [
                            if (receiverName.isNotEmpty) receiverName,
                            if (receiverPhone.isNotEmpty) receiverPhone,
                          ].join(' · '),
                          style: TextStyle(
                            fontSize: 12,
                            color: Theme.of(context)
                                .colorScheme
                                .onSurface
                                .withValues(alpha: 0.68),
                          ),
                        ),
                      ],
                      const SizedBox(height: 8),
                      Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: [
                          if (canQuickAck)
                            FilledButton.tonal(
                              onPressed:
                                  _loading ? null : () => _acknowledgeQuick(o),
                              child: const Text('발주확인'),
                            ),
                          if (canQuickInvoice)
                            FilledButton.tonal(
                              onPressed: _loading
                                  ? null
                                  : () => _uploadInvoiceQuick(o),
                              child: const Text('송장 입력'),
                            ),
                          OutlinedButton(
                            onPressed:
                                _loading ? null : () => _openOrderDetail(o),
                            child: Text(needsAction ? '처리 계속' : '상세 보기'),
                          ),
                        ],
                      ),
                    ],
                  ),
                );
              },
            ),
        ],
      ),
    );
  }
}

class _OrderMetric extends StatelessWidget {
  const _OrderMetric({
    required this.title,
    required this.value,
    required this.subtitle,
  });

  final String title;
  final String value;
  final String subtitle;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Container(
      width: 150,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: cs.primary.withValues(alpha: 0.06),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w700,
              color: cs.onSurface.withValues(alpha: 0.68),
            ),
          ),
          const SizedBox(height: 6),
          Text(
            value,
            style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w900),
          ),
          const SizedBox(height: 4),
          Text(
            subtitle,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 12,
              color: cs.onSurface.withValues(alpha: 0.62),
            ),
          ),
        ],
      ),
    );
  }
}
