import 'package:couplus_mobile/api/api_client.dart';
import 'package:couplus_mobile/ui/widgets.dart';
import 'package:flutter/material.dart';

class OrderDetailScreen extends StatefulWidget {
  const OrderDetailScreen({
    super.key,
    required this.order,
    required this.api,
    this.onChanged,
  });

  final Map<String, dynamic> order;
  final ApiClient api;
  final VoidCallback? onChanged;

  @override
  State<OrderDetailScreen> createState() => _OrderDetailScreenState();
}

class _OrderDetailScreenState extends State<OrderDetailScreen> {
  final _deliveryCompanyCode = TextEditingController();
  final _invoiceNumber = TextEditingController();

  bool _loading = false;
  String? _error;
  Map<String, dynamic>? _lastAck;
  Map<String, dynamic>? _lastInvoiceUpload;

  Map<String, dynamic> get _raw =>
      (widget.order['order'] as Map?)?.cast<String, dynamic>() ?? {};
  Map<String, dynamic> get _sheet =>
      (_raw['sheet'] as Map?)?.cast<String, dynamic>() ?? {};
  Map<String, dynamic> get _item =>
      (_raw['item'] as Map?)?.cast<String, dynamic>() ?? {};
  Map<String, dynamic> get _receiver =>
      (_sheet['receiver'] as Map?)?.cast<String, dynamic>() ?? {};

  String get _status => (widget.order['status'] ?? '').toString();
  String get _shipmentBoxId =>
      (_sheet['shipmentBoxId'] ?? widget.order['externalId'] ?? '').toString();
  String get _orderId => (_sheet['orderId'] ?? '').toString();
  String get _vendorItemId =>
      (_item['vendorItemId'] ?? widget.order['externalSubId'] ?? '').toString();

  bool get _canAcknowledge =>
      _shipmentBoxId.isNotEmpty && _status.trim().toUpperCase() == 'ACCEPT';

  bool get _canUploadInvoice =>
      _shipmentBoxId.isNotEmpty &&
      _orderId.isNotEmpty &&
      _vendorItemId.isNotEmpty;

  @override
  void dispose() {
    _deliveryCompanyCode.dispose();
    _invoiceNumber.dispose();
    super.dispose();
  }

  Future<void> _acknowledge() async {
    if (_shipmentBoxId.isEmpty) {
      setState(() => _error = 'shipmentBoxId가 없어 발주확인을 진행할 수 없습니다.');
      return;
    }

    setState(() {
      _loading = true;
      _error = null;
      _lastAck = null;
    });

    try {
      final json =
          await widget.api.postJson('/api/orders/coupang/acknowledge', {
        'shipmentBoxId': _shipmentBoxId,
      });
      final result = (json['result'] as Map?)?.cast<String, dynamic>() ?? {};
      setState(() => _lastAck = result);
      widget.onChanged?.call();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('쿠팡 발주확인 처리를 요청했습니다.')),
        );
      }
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _uploadInvoice() async {
    if (_shipmentBoxId.isEmpty || _orderId.isEmpty || _vendorItemId.isEmpty) {
      setState(() => _error = '주문 식별값이 부족해 송장 업로드를 진행할 수 없습니다.');
      return;
    }
    if (_invoiceNumber.text.trim().isEmpty) {
      setState(() => _error = '운송장 번호를 입력해 주세요.');
      return;
    }

    setState(() {
      _loading = true;
      _error = null;
      _lastInvoiceUpload = null;
    });

    try {
      final json = await widget.api.postJson('/api/orders/coupang/invoices', {
        'items': [
          {
            'shipmentBoxId': _shipmentBoxId,
            'orderId': _orderId,
            'vendorItemId': _vendorItemId,
            'deliveryCompanyCode': _deliveryCompanyCode.text.trim(),
            'invoiceNumber': _invoiceNumber.text.trim(),
          }
        ],
      });
      final result = (json['result'] as Map?)?.cast<String, dynamic>() ?? {};
      setState(() => _lastInvoiceUpload = result);
      widget.onChanged?.call();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('쿠팡 송장 업로드를 요청했습니다.')),
        );
      }
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Widget _resultCard(
    BuildContext context, {
    required String title,
    required Map<String, dynamic>? result,
  }) {
    if (result == null) return const SizedBox.shrink();
    final responseList = (result['responseList'] as List?) ?? const [];
    final first = responseList.isNotEmpty
        ? (responseList.first as Map).cast<String, dynamic>()
        : const <String, dynamic>{};
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: AppCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SectionHeader(title),
            const SizedBox(height: 10),
            KvRow(
                k: 'responseCode',
                v: (result['responseCode'] ?? '-').toString()),
            KvRow(
                k: 'responseMessage',
                v: (result['responseMessage'] ?? '-').toString()),
            KvRow(k: 'synced', v: (result['synced'] ?? '-').toString()),
            if (first.isNotEmpty) ...[
              KvRow(
                  k: 'first.resultCode',
                  v: (first['resultCode'] ?? '-').toString()),
              KvRow(
                  k: 'first.resultMessage',
                  v: (first['resultMessage'] ?? '-').toString()),
              KvRow(
                  k: 'first.retryRequired',
                  v: (first['retryRequired'] ?? '-').toString()),
            ],
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final at = (widget.order['at'] ?? '').toString();
    final name = (_receiver['name'] ?? '').toString();
    final postCode = (_receiver['postCode'] ?? '').toString();
    final addr1 = (_receiver['addr1'] ?? '').toString();
    final addr2 = (_receiver['addr2'] ?? '').toString();
    final phone = (_receiver['receiverNumber'] ?? _receiver['safeNumber'] ?? '')
        .toString();

    final title = (_item['vendorItemName'] ?? _item['sellerProductName'] ?? '')
        .toString();
    final qty = (_item['shippingCount'] ?? '').toString();
    final statusUpper = _status.trim().toUpperCase();
    final statusColor = switch (statusUpper) {
      'ACCEPT' => const Color(0xFFE67700),
      'INSTRUCT' => const Color(0xFF1971C2),
      'READY' => const Color(0xFF5F3DC4),
      'DELIVERING' => const Color(0xFF2F9E44),
      'DONE' => const Color(0xFF2B8A3E),
      _ => Theme.of(context).colorScheme.outline,
    };
    final nextAction = switch (statusUpper) {
      'ACCEPT' => '먼저 쿠팡 발주확인을 처리하세요.',
      'INSTRUCT' || 'READY' => '공급처 주문과 결제, 송장 확보를 진행하세요.',
      'DELIVERING' => '배송중 상태입니다. 송장 반영 여부만 확인하면 됩니다.',
      'DONE' => '이미 처리 완료된 주문입니다.',
      _ => '주문 상태를 확인한 뒤 필요한 작업을 진행하세요.',
    };

    return AppScaffold(
      title: '주문 상세',
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (_error != null) ...[
              ErrorBanner(
                message: _error!,
                onRetry: _loading ? null : () => setState(() => _error = null),
              ),
              const SizedBox(height: 12),
            ],
            AppCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      InfoChip(
                        label: _status.isEmpty ? '-' : _status,
                        color: statusColor,
                      ),
                      if (qty.isNotEmpty)
                        InfoChip(
                          label: '수량 $qty',
                          color: Theme.of(context).colorScheme.outline,
                        ),
                    ],
                  ),
                  const SizedBox(height: 10),
                  Text(
                    title.isEmpty ? '(상품명 없음)' : title,
                    style: const TextStyle(fontWeight: FontWeight.w900),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    nextAction,
                    style: TextStyle(
                      color: Theme.of(context)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: 0.72),
                    ),
                  ),
                  const SizedBox(height: 10),
                  Wrap(
                    spacing: 8,
                    runSpacing: 6,
                    children: [
                      if (name.isNotEmpty)
                        InfoChip(
                          label: name,
                          color: Theme.of(context).colorScheme.outline,
                        ),
                      if (phone.isNotEmpty)
                        InfoChip(
                          label: phone,
                          color: Theme.of(context).colorScheme.outline,
                        ),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            AppCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const SectionHeader('주문 처리'),
                  const SizedBox(height: 12),
                  Text(
                    '1. 발주확인',
                    style: TextStyle(
                      fontWeight: FontWeight.w900,
                      color: Theme.of(context).colorScheme.onSurface,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    _canAcknowledge
                        ? '쿠팡에서 이 주문을 실제 처리 대상으로 넘깁니다.'
                        : '현재 상태에서는 발주확인을 다시 누를 필요가 없습니다.',
                    style: TextStyle(
                      color: Theme.of(context)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: 0.68),
                    ),
                  ),
                  const SizedBox(height: 10),
                  FilledButton(
                    onPressed:
                        _loading || !_canAcknowledge ? null : _acknowledge,
                    child: const Text('발주확인 처리'),
                  ),
                  const Divider(height: 28),
                  Text(
                    '2. 송장 업로드',
                    style: TextStyle(
                      fontWeight: FontWeight.w900,
                      color: Theme.of(context).colorScheme.onSurface,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    '공급처 주문이 끝나고 운송장 번호가 나오면 여기서 바로 쿠팡에 반영합니다.',
                    style: TextStyle(
                      color: Theme.of(context)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: 0.68),
                    ),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    controller: _deliveryCompanyCode,
                    decoration: const InputDecoration(
                      labelText: '택배사 코드 (비워두면 저장된 기본값 사용)',
                      hintText: '예: KDEXP',
                      border: OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    controller: _invoiceNumber,
                    decoration: const InputDecoration(
                      labelText: '운송장 번호',
                      border: OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 10),
                  FilledButton.tonal(
                    onPressed:
                        _loading || !_canUploadInvoice ? null : _uploadInvoice,
                    child: const Text('송장 업로드'),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            AppCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const SectionHeader('참고 정보'),
                  const SizedBox(height: 10),
                  KvRow(k: '시간', v: at.isEmpty ? '-' : at),
                  KvRow(
                      k: 'shipmentBoxId',
                      v: _shipmentBoxId.isEmpty ? '-' : _shipmentBoxId),
                  KvRow(k: 'orderId', v: _orderId.isEmpty ? '-' : _orderId),
                  KvRow(
                      k: 'vendorItemId',
                      v: _vendorItemId.isEmpty ? '-' : _vendorItemId),
                  KvRow(k: '우편번호', v: postCode.isEmpty ? '-' : postCode),
                  KvRow(k: '주소', v: addr1.isEmpty ? '-' : addr1),
                  KvRow(k: '상세주소', v: addr2.isEmpty ? '-' : addr2),
                ],
              ),
            ),
            _resultCard(context, title: '발주확인 결과', result: _lastAck),
            _resultCard(context,
                title: '송장 업로드 결과', result: _lastInvoiceUpload),
          ],
        ),
      ),
    );
  }
}
