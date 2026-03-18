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
      final json = await widget.api.postJson('/api/orders/coupang/acknowledge', {
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
    final first = responseList.isNotEmpty ? (responseList.first as Map).cast<String, dynamic>() : const <String, dynamic>{};
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: AppCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SectionHeader(title),
            const SizedBox(height: 10),
            KvRow(k: 'responseCode', v: (result['responseCode'] ?? '-').toString()),
            KvRow(k: 'responseMessage', v: (result['responseMessage'] ?? '-').toString()),
            KvRow(k: 'synced', v: (result['synced'] ?? '-').toString()),
            if (first.isNotEmpty) ...[
              KvRow(k: 'first.resultCode', v: (first['resultCode'] ?? '-').toString()),
              KvRow(k: 'first.resultMessage', v: (first['resultMessage'] ?? '-').toString()),
              KvRow(k: 'first.retryRequired', v: (first['retryRequired'] ?? '-').toString()),
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
    final phone =
        (_receiver['receiverNumber'] ?? _receiver['safeNumber'] ?? '').toString();

    final title =
        (_item['vendorItemName'] ?? _item['sellerProductName'] ?? '').toString();
    final qty = (_item['shippingCount'] ?? '').toString();

    return AppScaffold(
      title: '주문 상세',
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
          if (_error != null) ...[
            ErrorBanner(message: _error!, onRetry: _loading ? null : () => setState(() => _error = null)),
            const SizedBox(height: 12),
          ],
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SectionHeader('주문 정보'),
                const SizedBox(height: 10),
                KvRow(k: '상태', v: _status.isEmpty ? '-' : _status),
                KvRow(k: '시간', v: at.isEmpty ? '-' : at),
                KvRow(k: 'shipmentBoxId', v: _shipmentBoxId.isEmpty ? '-' : _shipmentBoxId),
                KvRow(k: 'orderId', v: _orderId.isEmpty ? '-' : _orderId),
                KvRow(k: 'vendorItemId', v: _vendorItemId.isEmpty ? '-' : _vendorItemId),
              ],
            ),
          ),
          const SizedBox(height: 12),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SectionHeader('상품'),
                const SizedBox(height: 10),
                Text(
                  title.isEmpty ? '(상품명 없음)' : title,
                  style: const TextStyle(fontWeight: FontWeight.w900),
                ),
                const SizedBox(height: 8),
                KvRow(k: '수량', v: qty.isEmpty ? '-' : qty),
              ],
            ),
          ),
          const SizedBox(height: 12),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SectionHeader('받는 사람'),
                const SizedBox(height: 10),
                KvRow(k: '이름', v: name.isEmpty ? '-' : name),
                KvRow(k: '전화', v: phone.isEmpty ? '-' : phone),
                KvRow(k: '우편번호', v: postCode.isEmpty ? '-' : postCode),
                KvRow(k: '주소', v: addr1.isEmpty ? '-' : addr1),
                KvRow(k: '상세주소', v: addr2.isEmpty ? '-' : addr2),
              ],
            ),
          ),
          const SizedBox(height: 12),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SectionHeader('쿠팡 처리'),
                const SizedBox(height: 10),
                FilledButton(
                  onPressed: _loading || _shipmentBoxId.isEmpty ? null : _acknowledge,
                  child: const Text('발주확인 처리'),
                ),
                const SizedBox(height: 14),
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
                  onPressed: _loading ? null : _uploadInvoice,
                  child: const Text('송장 업로드'),
                ),
              ],
            ),
          ),
          _resultCard(context, title: '발주확인 결과', result: _lastAck),
            _resultCard(context, title: '송장 업로드 결과', result: _lastInvoiceUpload),
          ],
        ),
      ),
    );
  }
}
