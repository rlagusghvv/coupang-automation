import 'dart:convert';

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
  final Future<void> Function()? onChanged;

  @override
  State<OrderDetailScreen> createState() => _OrderDetailScreenState();
}

class _OrderDetailScreenState extends State<OrderDetailScreen> {
  final _deliveryCompanyCode = TextEditingController();
  final _invoiceNumber = TextEditingController();

  bool _loading = false;
  bool _checkingDomeggookPreflight = false;
  String? _error;
  late Map<String, dynamic> _order;
  Map<String, dynamic>? _lastAck;
  Map<String, dynamic>? _lastInvoiceUpload;
  Map<String, dynamic>? _lastDomeggookCreate;
  Map<String, dynamic>? _lastDomeggookInvoiceSync;
  Map<String, dynamic>? _domeggookPreflight;

  Map<String, dynamic> get _raw =>
      (_order['order'] as Map?)?.cast<String, dynamic>() ?? {};
  Map<String, dynamic> get _sheet =>
      (_raw['sheet'] as Map?)?.cast<String, dynamic>() ?? {};
  Map<String, dynamic> get _item =>
      (_raw['item'] as Map?)?.cast<String, dynamic>() ?? {};
  Map<String, dynamic> get _receiver =>
      (_sheet['receiver'] as Map?)?.cast<String, dynamic>() ?? {};

  String get _status => (_order['status'] ?? '').toString();
  String get _shipmentBoxId =>
      (_sheet['shipmentBoxId'] ?? _order['externalId'] ?? '').toString();
  String get _orderId => (_sheet['orderId'] ?? '').toString();
  String get _vendorItemId =>
      (_item['vendorItemId'] ?? _order['externalSubId'] ?? '').toString();

  bool get _canAcknowledge =>
      _shipmentBoxId.isNotEmpty && _status.trim().toUpperCase() == 'ACCEPT';

  bool get _canUploadInvoice =>
      _shipmentBoxId.isNotEmpty &&
      _orderId.isNotEmpty &&
      _vendorItemId.isNotEmpty;

  bool get _canStartDomeggookOrder {
    final preflight = _domeggookPreflight;
    if (preflight == null) return !_checkingDomeggookPreflight;
    final canOrder = preflight['canOrder'];
    final code = (preflight['error'] ?? '').toString().trim();
    if (canOrder == false) return false;
    if (code == 'supplier_mapping_missing' ||
        code == 'minimum_order_qty_gt_1' ||
        code == 'missing_domeggook_private_credentials') {
      return false;
    }
    return true;
  }

  @override
  void initState() {
    super.initState();
    _order = _cloneOrder(widget.order);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _reloadOrder(silent: true);
      _loadDomeggookPreflight();
    });
  }

  @override
  void didUpdateWidget(covariant OrderDetailScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    final oldId = oldWidget.order['id'];
    final nextId = widget.order['id'];
    if ('$oldId' != '$nextId') {
      _order = _cloneOrder(widget.order);
    }
  }

  @override
  void dispose() {
    _deliveryCompanyCode.dispose();
    _invoiceNumber.dispose();
    super.dispose();
  }

  Map<String, dynamic> _cloneOrder(Map<String, dynamic> source) {
    try {
      return (jsonDecode(jsonEncode(source)) as Map).cast<String, dynamic>();
    } catch (_) {
      return Map<String, dynamic>.from(source);
    }
  }

  Map<String, dynamic>? _extractErrorPayload(Object error) {
    if (error is! ApiException) return null;
    final raw = (error.details ?? '').trim();
    if (raw.isEmpty) return null;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is Map) return decoded.cast<String, dynamic>();
    } catch (_) {}
    return null;
  }

  String _friendlyOrderError(Object error, {Map<String, dynamic>? payload}) {
    final body =
        payload ?? _extractErrorPayload(error) ?? const <String, dynamic>{};
    final topError = (body['error'] ?? '').toString().trim();
    final result =
        (body['result'] as Map?)?.cast<String, dynamic>() ??
        const <String, dynamic>{};
    final resultError = (result['error'] ?? '').toString().trim();
    final code = resultError.isNotEmpty ? resultError : topError;
    switch (code) {
      case 'too_less_emoney_precheck':
        final asset =
            (result['asset'] as Map?)?.cast<String, dynamic>() ??
            const <String, dynamic>{};
        final estimate =
            (result['estimate'] as Map?)?.cast<String, dynamic>() ??
            const <String, dynamic>{};
        return '현금성 이머니가 부족합니다. 현재 ${_formatWon(asset['emoneyCash'])}, 예상 차감액 ${_formatWon(estimate['total'])} 입니다.';
      case 'supplier_mapping_missing':
        return '이 주문은 공급처 상품번호/옵션코드 매핑이 없어 도매꾹 자동 주문을 만들 수 없습니다.';
      case 'minimum_order_qty_gt_1':
        final minQty = result['minimumOrderQty'];
        return '공급처 최소 주문수량이 ${minQty ?? '-'}개라 자동 주문을 막았습니다.';
      case 'missing_domeggook_private_credentials':
        return '도매꾹 Private API 키, ID, 비밀번호를 먼저 입력해 주세요.';
      case 'order_not_found':
        return '주문 정보를 다시 불러와 주세요.';
      default:
        return error.toString();
    }
  }

  Future<void> _reloadOrder({bool silent = false}) async {
    final id = _order['id'];
    if (id == null) return;
    if (!silent) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final json = await widget.api.getJson('/api/orders/$id');
      final next = (json['order'] as Map?)?.cast<String, dynamic>();
      if (next == null || !mounted) return;
      setState(() => _order = _cloneOrder(next));
    } catch (e) {
      if (!silent && mounted) {
        setState(() => _error = e.toString());
      }
    } finally {
      if (!silent && mounted) {
        setState(() => _loading = false);
      }
    }
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

  Future<void> _loadDomeggookPreflight() async {
    final orderId = _order['id'];
    if (orderId == null) return;
    setState(() {
      _checkingDomeggookPreflight = true;
      _error = null;
    });
    try {
      final json = await widget.api.postJson(
        '/api/orders/domeggook/preflight',
        {'orderId': orderId, 'receipt': 0},
      );
      final result = (json['result'] as Map?)?.cast<String, dynamic>() ?? {};
      if (mounted) {
        setState(() => _domeggookPreflight = result);
      }
    } catch (e) {
      final payload = _extractErrorPayload(e);
      final result = (payload?['result'] as Map?)?.cast<String, dynamic>();
      if (mounted) {
        setState(() {
          _domeggookPreflight = result;
          _error = _friendlyOrderError(e, payload: payload);
        });
      }
    } finally {
      if (mounted) setState(() => _checkingDomeggookPreflight = false);
    }
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
      final json = await widget.api.postJson(
        '/api/orders/coupang/acknowledge',
        {'shipmentBoxId': _shipmentBoxId},
      );
      final result = (json['result'] as Map?)?.cast<String, dynamic>() ?? {};
      setState(() => _lastAck = result);
      await _reloadOrder(silent: true);
      await widget.onChanged?.call();
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('쿠팡 발주확인 처리를 요청했습니다.')));
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
          },
        ],
      });
      final result = (json['result'] as Map?)?.cast<String, dynamic>() ?? {};
      setState(() => _lastInvoiceUpload = result);
      await _reloadOrder(silent: true);
      await widget.onChanged?.call();
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('쿠팡 송장 업로드를 요청했습니다.')));
      }
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _createDomeggookOrder() async {
    final orderId = _order['id'];
    if (orderId == null) {
      setState(() => _error = '주문 ID가 없어 도매꾹 자동 주문을 진행할 수 없습니다.');
      return;
    }

    setState(() {
      _loading = true;
      _error = null;
      _lastDomeggookCreate = null;
    });

    try {
      final json = await widget.api.postJson('/api/orders/domeggook/create', {
        'orderId': orderId,
        'receipt': 0,
      });
      final result = (json['result'] as Map?)?.cast<String, dynamic>() ?? {};
      setState(() {
        _lastDomeggookCreate = result;
        _domeggookPreflight = result;
      });
      await _reloadOrder(silent: true);
      await widget.onChanged?.call();
      if (mounted) {
        final orders = (result['orderCreate'] as Map?)?['orders'] as List?;
        final orderNo = orders != null && orders.isNotEmpty
            ? ((orders.first as Map)['orderNo'] ?? '').toString()
            : '';
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              orderNo.isNotEmpty
                  ? '도매꾹 주문 생성 완료: $orderNo'
                  : '도매꾹 주문 생성 결과를 확인해 주세요.',
            ),
          ),
        );
      }
    } catch (e) {
      final payload = _extractErrorPayload(e);
      final result = (payload?['result'] as Map?)?.cast<String, dynamic>();
      if (mounted) {
        setState(() {
          _domeggookPreflight = result;
          _error = _friendlyOrderError(e, payload: payload);
        });
      }
    } finally {
      await _loadDomeggookPreflight();
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _syncDomeggookInvoice() async {
    final orderId = _order['id'];
    if (orderId == null) {
      setState(() => _error = '주문 ID가 없어 송장 자동 반영을 진행할 수 없습니다.');
      return;
    }

    setState(() {
      _loading = true;
      _error = null;
      _lastDomeggookInvoiceSync = null;
    });

    try {
      final json = await widget.api.postJson(
        '/api/orders/domeggook/sync-invoice',
        {'orderId': orderId},
      );
      final result = (json['result'] as Map?)?.cast<String, dynamic>() ?? {};
      setState(() => _lastDomeggookInvoiceSync = result);
      await _reloadOrder(silent: true);
      await widget.onChanged?.call();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              '도매꾹 송장 ${result['invoiceNumber'] ?? '-'} 를 쿠팡에 반영했습니다.',
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

  String _preflightHint(Map<String, dynamic>? preflight) {
    final data = preflight ?? const <String, dynamic>{};
    final code = (data['error'] ?? data['canOrderReason'] ?? '')
        .toString()
        .trim();
    switch (code) {
      case 'too_less_emoney_precheck':
      case 'too_less_emoney':
        final asset =
            (data['asset'] as Map?)?.cast<String, dynamic>() ??
            const <String, dynamic>{};
        final estimate =
            (data['estimate'] as Map?)?.cast<String, dynamic>() ??
            const <String, dynamic>{};
        return '현금성 이머니 ${_formatWon(asset['emoneyCash'])}, 예상 차감액 ${_formatWon(estimate['total'])} 입니다. 충전 후 다시 확인해 주세요.';
      case 'supplier_mapping_missing':
        return '공급처 상품번호/옵션코드 매핑이 없어 자동 주문을 만들 수 없습니다.';
      case 'minimum_order_qty_gt_1':
        final minQty = data['minimumOrderQty'];
        return '공급처 최소 주문수량이 ${minQty ?? '-'}개라 자동 주문을 막았습니다.';
      case 'missing_domeggook_private_credentials':
        return '도매꾹 Private API 자격정보를 먼저 입력해 주세요.';
      case 'estimate_unavailable':
        return '예상 차감액 계산이 안 돼 잔액만 확인된 상태입니다.';
      case 'enough_emoney':
        return '현재 잔액으로 자동 주문 가능한 상태입니다.';
      default:
        return '';
    }
  }

  Widget _resultCard(
    BuildContext context, {
    required String title,
    required Map<String, dynamic>? result,
  }) {
    if (result == null) return const SizedBox.shrink();
    final invoiceSync =
        (result['orderView'] as Map?)?.cast<String, dynamic>() ??
        const <String, dynamic>{};
    if (invoiceSync.isNotEmpty && result['invoiceNumber'] != null) {
      final delivery =
          (invoiceSync['delivery'] as Map?)?.cast<String, dynamic>() ??
          const <String, dynamic>{};
      return Padding(
        padding: const EdgeInsets.only(top: 12),
        child: AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SectionHeader(title),
              const SizedBox(height: 10),
              KvRow(
                k: 'orderNo',
                v: (result['domeggookOrderNo'] ?? '-').toString(),
              ),
              KvRow(
                k: 'invoiceNumber',
                v: (result['invoiceNumber'] ?? '-').toString(),
              ),
              KvRow(
                k: 'deliveryCompanyCode',
                v: (result['deliveryCompanyCode'] ?? '-').toString(),
              ),
              KvRow(
                k: 'deliveryCompany',
                v: (delivery['companyName'] ?? delivery['company'] ?? '-')
                    .toString(),
              ),
              KvRow(
                k: 'status',
                v: (invoiceSync['statusMode'] ?? invoiceSync['status'] ?? '-')
                    .toString(),
              ),
            ],
          ),
        ),
      );
    }
    final orderCreate =
        (result['orderCreate'] as Map?)?.cast<String, dynamic>() ??
        const <String, dynamic>{};
    if (orderCreate.isNotEmpty) {
      final orders = (orderCreate['orders'] as List?) ?? const [];
      final first = orders.isNotEmpty
          ? (orders.first as Map).cast<String, dynamic>()
          : const <String, dynamic>{};
      final mapping =
          (result['mapping'] as Map?)?.cast<String, dynamic>() ??
          const <String, dynamic>{};
      final payload =
          (result['payloadPreview'] as Map?)?.cast<String, dynamic>() ??
          const <String, dynamic>{};
      return Padding(
        padding: const EdgeInsets.only(top: 12),
        child: AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SectionHeader(title),
              const SizedBox(height: 10),
              KvRow(k: 'result', v: (orderCreate['result'] ?? '-').toString()),
              KvRow(k: 'itemNo', v: (mapping['itemNo'] ?? '-').toString()),
              KvRow(
                k: 'optionCode',
                v: (mapping['optionCode'] ?? '-').toString(),
              ),
              KvRow(
                k: 'shippingMethod',
                v: (mapping['shippingMethodCode'] ?? '-').toString(),
              ),
              if (first.isNotEmpty) ...[
                KvRow(k: 'orderNo', v: (first['orderNo'] ?? '-').toString()),
                KvRow(k: '수령인', v: (first['getName'] ?? '-').toString()),
              ],
              if (payload['deliinfo'] != null)
                KvRow(k: 'deliinfo', v: payload['deliinfo'].toString()),
            ],
          ),
        ),
      );
    }
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
              v: (result['responseCode'] ?? '-').toString(),
            ),
            KvRow(
              k: 'responseMessage',
              v: (result['responseMessage'] ?? '-').toString(),
            ),
            KvRow(k: 'synced', v: (result['synced'] ?? '-').toString()),
            if (first.isNotEmpty) ...[
              KvRow(
                k: 'first.resultCode',
                v: (first['resultCode'] ?? '-').toString(),
              ),
              KvRow(
                k: 'first.resultMessage',
                v: (first['resultMessage'] ?? '-').toString(),
              ),
              KvRow(
                k: 'first.retryRequired',
                v: (first['retryRequired'] ?? '-').toString(),
              ),
            ],
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final at = (_order['at'] ?? '').toString();
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
    final preflightHint = _preflightHint(_domeggookPreflight);
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
                      color: Theme.of(
                        context,
                      ).colorScheme.onSurface.withValues(alpha: 0.72),
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
                      color: Theme.of(
                        context,
                      ).colorScheme.onSurface.withValues(alpha: 0.68),
                    ),
                  ),
                  const SizedBox(height: 10),
                  FilledButton(
                    onPressed: _loading || !_canAcknowledge
                        ? null
                        : _acknowledge,
                    child: const Text('발주확인 처리'),
                  ),
                  const Divider(height: 28),
                  Text(
                    '2. 도매꾹 자동 주문',
                    style: TextStyle(
                      fontWeight: FontWeight.w900,
                      color: Theme.of(context).colorScheme.onSurface,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    '공급처 상품번호와 옵션코드가 매핑된 주문이면 바로 도매꾹 구매주문을 생성합니다. e-money가 차감될 수 있습니다.',
                    style: TextStyle(
                      color: Theme.of(
                        context,
                      ).colorScheme.onSurface.withValues(alpha: 0.68),
                    ),
                  ),
                  const SizedBox(height: 10),
                  if (_checkingDomeggookPreflight)
                    Text(
                      '이머니 잔액과 예상 차감액을 확인하는 중입니다.',
                      style: TextStyle(
                        color: Theme.of(
                          context,
                        ).colorScheme.onSurface.withValues(alpha: 0.68),
                      ),
                    )
                  else if (_domeggookPreflight != null) ...[
                    KvRow(
                      k: '총 이머니',
                      v: _formatWon(
                        ((_domeggookPreflight?['asset']
                            as Map?)?['emoneyTotal']),
                      ),
                    ),
                    KvRow(
                      k: '현금성 이머니',
                      v: _formatWon(
                        ((_domeggookPreflight?['asset']
                            as Map?)?['emoneyCash']),
                      ),
                    ),
                    KvRow(
                      k: '예상 차감액',
                      v: _formatWon(
                        ((_domeggookPreflight?['estimate'] as Map?)?['total']),
                      ),
                    ),
                    KvRow(
                      k: '주문 가능',
                      v: (_domeggookPreflight?['canOrder'] == false)
                          ? '불가'
                          : ((_domeggookPreflight?['canOrder'] == true)
                                ? '가능'
                                : '잔액만 확인됨'),
                    ),
                    if (((_domeggookPreflight?['mapping'] as Map?)
                            ?.isNotEmpty ??
                        false)) ...[
                      KvRow(
                        k: '공급처 상품번호',
                        v:
                            (((_domeggookPreflight?['mapping']
                                        as Map?)?['itemNo']) ??
                                    '-')
                                .toString(),
                      ),
                      KvRow(
                        k: '옵션코드',
                        v:
                            (((_domeggookPreflight?['mapping']
                                        as Map?)?['optionCode']) ??
                                    '-')
                                .toString(),
                      ),
                    ],
                    if (preflightHint.isNotEmpty)
                      Text(
                        preflightHint,
                        style: TextStyle(
                          color: (_domeggookPreflight?['canOrder'] == false)
                              ? Theme.of(context).colorScheme.error
                              : Theme.of(
                                  context,
                                ).colorScheme.onSurface.withValues(alpha: 0.78),
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                  ],
                  const SizedBox(height: 10),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      FilledButton.tonal(
                        onPressed:
                            _loading ||
                                _checkingDomeggookPreflight ||
                                !_canStartDomeggookOrder
                            ? null
                            : _createDomeggookOrder,
                        child: const Text('도매꾹 자동 주문'),
                      ),
                      OutlinedButton(
                        onPressed: _loading || _checkingDomeggookPreflight
                            ? null
                            : _loadDomeggookPreflight,
                        child: const Text('잔액 확인'),
                      ),
                    ],
                  ),
                  const Divider(height: 28),
                  Text(
                    '3. 송장 자동 반영',
                    style: TextStyle(
                      fontWeight: FontWeight.w900,
                      color: Theme.of(context).colorScheme.onSurface,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    '도매꾹 주문번호가 저장돼 있으면 송장번호를 조회해 쿠팡에 바로 반영합니다.',
                    style: TextStyle(
                      color: Theme.of(
                        context,
                      ).colorScheme.onSurface.withValues(alpha: 0.68),
                    ),
                  ),
                  const SizedBox(height: 10),
                  FilledButton.tonal(
                    onPressed: _loading ? null : _syncDomeggookInvoice,
                    child: const Text('도매꾹 송장 가져와 쿠팡 반영'),
                  ),
                  const Divider(height: 28),
                  Text(
                    '4. 수동 송장 업로드',
                    style: TextStyle(
                      fontWeight: FontWeight.w900,
                      color: Theme.of(context).colorScheme.onSurface,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    '공급처 주문이 끝나고 운송장 번호가 나오면 여기서 바로 쿠팡에 반영합니다.',
                    style: TextStyle(
                      color: Theme.of(
                        context,
                      ).colorScheme.onSurface.withValues(alpha: 0.68),
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
                    onPressed: _loading || !_canUploadInvoice
                        ? null
                        : _uploadInvoice,
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
                    v: _shipmentBoxId.isEmpty ? '-' : _shipmentBoxId,
                  ),
                  KvRow(k: 'orderId', v: _orderId.isEmpty ? '-' : _orderId),
                  KvRow(
                    k: 'vendorItemId',
                    v: _vendorItemId.isEmpty ? '-' : _vendorItemId,
                  ),
                  KvRow(k: '우편번호', v: postCode.isEmpty ? '-' : postCode),
                  KvRow(k: '주소', v: addr1.isEmpty ? '-' : addr1),
                  KvRow(k: '상세주소', v: addr2.isEmpty ? '-' : addr2),
                ],
              ),
            ),
            _resultCard(context, title: '발주확인 결과', result: _lastAck),
            _resultCard(
              context,
              title: '송장 업로드 결과',
              result: _lastInvoiceUpload,
            ),
            _resultCard(
              context,
              title: '도매꾹 자동 주문 결과',
              result: _lastDomeggookCreate,
            ),
            _resultCard(
              context,
              title: '도매꾹 송장 자동 반영 결과',
              result: _lastDomeggookInvoiceSync,
            ),
          ],
        ),
      ),
    );
  }
}
